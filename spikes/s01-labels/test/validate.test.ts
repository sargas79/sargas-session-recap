import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { loadValidator, overlaps, semanticIssues, type IssueCode } from "../src/validate.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(here, "../../../fixtures/evaluation");
const invalidDir = join(fixturesDir, "invalid");
const validFixture = join(fixturesDir, "label-set.synthetic.valid.json");
const cli = resolve(here, "../src/cli.ts");

const readJson = (p: string): unknown => JSON.parse(readFileSync(p, "utf8"));
const validate = loadValidator();

// Every invalid fixture must be listed here with the issue code it is meant to trigger.
const expectedInvalid: Record<string, IssueCode> = {
  "unknown-label": "schema",
  "mixed-without-notes": "schema",
  "action-missing-status": "schema",
  "outcome-missing-basis": "schema",
  "consent-inline": "schema",
  "speaker-not-pseudonymous": "schema",
  "overlapping-split": "split_overlap",
  "empty-split-range": "range_empty",
  "segment-outside-split": "segment_not_in_split",
  "segment-straddles-split": "segment_not_in_split",
  "end-before-start": "segment_end_not_after_start",
  "duplicate-segment": "duplicate_segment",
  "same-speaker-overlap": "same_speaker_overlap",
};

describe("valid synthetic fixtures", () => {
  const validFiles = readdirSync(fixturesDir).filter((f) => f.endsWith(".valid.json"));

  it("has at least one valid fixture", () => {
    expect(validFiles.length).toBeGreaterThan(0);
  });

  it.each(validFiles)("%s validates against label.schema.json with no semantic issues", (file) => {
    expect(validate(readJson(join(fixturesDir, file)))).toEqual([]);
  });

  it.each(validFiles)("%s is marked synthetic (no real labels in git)", (file) => {
    const doc = readJson(join(fixturesDir, file)) as { synthetic: boolean; labeller_role: string };
    expect(doc.synthetic).toBe(true);
    expect(doc.labeller_role).toBe("synthetic");
  });

  it("covers all six labels and the recap-critical item types used in the guide", () => {
    const doc = readJson(validFixture) as {
      labels: { label: string; recap_critical?: { type: string; action_status?: string; outcome_basis?: string }[] }[];
    };
    expect(new Set(doc.labels.map((l) => l.label))).toEqual(
      new Set(["ic", "narration", "rules", "ooc", "mixed", "uncertain"]),
    );
    const items = doc.labels.flatMap((l) => l.recap_critical ?? []);
    for (const t of ["decision", "clue", "npc_name", "loot", "action", "outcome"]) {
      expect(items.some((i) => i.type === t)).toBe(true);
    }
    expect(new Set(items.map((i) => i.action_status).filter(Boolean))).toEqual(
      new Set(["proposed", "completed", "abandoned"]),
    );
    expect(items.some((i) => i.outcome_basis === "roll")).toBe(true);
  });
});

describe("invalid fixtures", () => {
  const invalidFiles = readdirSync(invalidDir).filter((f) => f.endsWith(".invalid.json"));

  it("every invalid fixture has an expectation and vice versa", () => {
    const names = invalidFiles.map((f) => f.replace(/\.invalid\.json$/, "")).sort();
    expect(names).toEqual(Object.keys(expectedInvalid).sort());
  });

  it.each(invalidFiles)("%s is rejected with the expected issue code", (file) => {
    const name = file.replace(/\.invalid\.json$/, "");
    const issues = validate(readJson(join(invalidDir, file)));
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.map((i) => i.code)).toContain(expectedInvalid[name]);
  });
});

describe("split disjointness", () => {
  const doc = (tuning: [number, number][], held_out: [number, number][], excluded: [number, number][] = []) => ({
    split: {
      tuning: tuning.map(([s, e]) => ({ start_ms: s, end_ms: e })),
      held_out: held_out.map(([s, e]) => ({ start_ms: s, end_ms: e })),
      excluded: excluded.map(([s, e]) => ({ start_ms: s, end_ms: e })),
    },
    labels: [],
  });
  const codes = (d: ReturnType<typeof doc>) => semanticIssues(d).map((i) => i.code);

  it("treats ranges as half-open, so touching ranges are disjoint", () => {
    expect(overlaps({ start_ms: 0, end_ms: 10 }, { start_ms: 10, end_ms: 20 })).toBe(false);
    expect(codes(doc([[0, 10]], [[10, 20]]))).toEqual([]);
  });

  it("rejects tuning/held-out overlap", () => {
    expect(codes(doc([[0, 11]], [[10, 20]]))).toContain("split_overlap");
  });

  it("rejects a held-out range nested inside a tuning range", () => {
    expect(codes(doc([[0, 100]], [[40, 60]]))).toContain("split_overlap");
  });

  it("rejects overlap within the same subset and with excluded ranges", () => {
    expect(codes(doc([[0, 10], [5, 15]], [[20, 30]]))).toContain("split_overlap");
    expect(codes(doc([[0, 10]], [[20, 30]], [[25, 40]]))).toContain("split_overlap");
  });

  it("accepts interleaved but disjoint blocks", () => {
    expect(codes(doc([[0, 10], [20, 30]], [[10, 20], [30, 40]]))).toEqual([]);
  });

  it("allows different speakers to overlap in time (crosstalk)", () => {
    const d = {
      ...doc([[0, 100]], [[100, 200]]),
      labels: [
        { segment: { speaker: "gm", start_ms: 10, end_ms: 50 } },
        { segment: { speaker: "p1", start_ms: 30, end_ms: 60 } },
      ],
    };
    expect(semanticIssues(d)).toEqual([]);
  });
});

describe("cli", () => {
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });

  it("exits 0 for the valid fixture", () => {
    const r = run(validFixture);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^OK /m);
  });

  it("exits 1 and names the issue code for an invalid fixture, without printing segment text", () => {
    const r = run(join(invalidDir, "overlapping-split.invalid.json"));
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("[split_overlap]");
  });

  it("exits 2 with no input", () => {
    expect(run().status).toBe(2);
  });

  // Privacy: diagnostics must never echo input-derived text (#50 review).
  const SENTINEL = "zzPrivateTranscriptSentinel";
  const tmp = mkdtempSync(join(tmpdir(), "s01-labels-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  const writeTmp = (name: string, content: string) => {
    const p = join(tmp, name);
    writeFileSync(p, content, "utf8");
    return p;
  };

  it("exits 2 on malformed JSON without echoing the input", () => {
    // JSON.parse quotes only a short excerpt around the error, so keep the leaked token short.
    const secret = "zzQx7";
    const file = writeTmp("malformed.json", `{"t": ${secret}}`);
    const r = run(file);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("cannot read/parse JSON");
    expect(r.stdout + r.stderr).not.toContain(secret);
  });

  it("exits 1 on an unexpected property without echoing the property name", () => {
    const doc = readJson(validFixture) as Record<string, unknown>;
    const file = writeTmp("extra-key.json", JSON.stringify({ ...doc, [SENTINEL]: true }));
    const r = run(file);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("[schema]");
    expect(r.stdout + r.stderr).not.toContain(SENTINEL);
  });

  it("exits 2 when --schema points to a missing file", () => {
    const r = run("--schema", join(tmp, "does-not-exist.schema.json"), validFixture);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("cannot read, parse or compile schema");
  });

  it("exits 2 when --schema is malformed, without echoing its content", () => {
    const schema = writeTmp("bad.schema.json", `{"type": ${SENTINEL}}`);
    const r = run("--schema", schema, validFixture);
    expect(r.status).toBe(2);
    expect(r.stdout + r.stderr).not.toContain(SENTINEL);
  });

  it("exits 2 when --schema is valid JSON but does not compile", () => {
    const schema = writeTmp("uncompilable.schema.json", JSON.stringify({ type: "no-such-type" }));
    expect(run("--schema", schema, validFixture).status).toBe(2);
  });
});
