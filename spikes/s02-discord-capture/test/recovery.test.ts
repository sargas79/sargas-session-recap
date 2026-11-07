import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { FakeClock } from "../src/clock.js";
import { readManifest } from "../src/manifest.js";
import { recoverAll, recoverSession } from "../src/recovery.js";
import { parseWavHeader } from "../src/wav.js";
import { P1, P2, makeSession, talk, tmpDir } from "./helpers.js";

/**
 * Simulated forced kill: the session is never stopped (no finalize, no session_stop), and a half-written
 * record is appended to the manifest, exactly what SIGKILL in the middle of an append leaves behind.
 */
function killedSession() {
  const root = tmpDir();
  const clock = new FakeClock();
  const s = makeSession(root, clock);
  clock.advanceMs(1000);
  talk(s, clock, P1, 50); // p1: 1000..2000, then finalized by silence
  s.onStreamEnd(P1);
  clock.advanceMs(500); // 2500
  talk(s, clock, P1, 100); // p1 open: 2500..4500
  talk(s, clock, P2, 25); // p2 open: 4500..5000
  const killHrNs = clock.nowNs(); // 5000 ms after t0
  const manifest = path.join(s.dir, "manifest.jsonl");
  fs.appendFileSync(manifest, '{"type":"event","t_ms":5000,"event":"mark","lab'); // truncated, no newline
  // A trailing partial sample (odd byte) from a write cut mid-sample.
  fs.appendFileSync(path.join(s.dir, "p2_000003.wav.part"), Buffer.from([0x7f]));
  return { root, dir: s.dir, manifest, killHrNs, t0: s.t0Ns };
}

describe("startup recovery after forced kill", () => {
  it("detects the truncated manifest tail, preserves it, and truncates to the last complete record", () => {
    const k = killedSession();
    const before = readManifest(k.manifest);
    expect(before.truncatedTail).toContain('"event":"mark"');
    const rep = recoverSession(k.dir, { killHrNs: k.killHrNs });
    expect(rep.manifest_truncated_tail).toBe(true);
    expect(fs.readFileSync(path.join(k.dir, "manifest.jsonl.corrupt-tail"), "utf8")).toContain('"lab');
    const after = readManifest(k.manifest);
    expect(after.truncatedTail).toBeNull();
    expect(after.corruptLines).toEqual([]);
  });

  it("detects .part files, salvages them with a valid header and reports the loss bound", () => {
    const k = killedSession();
    const parts = fs.readdirSync(k.dir).filter((f) => f.endsWith(".part")).sort();
    expect(parts).toEqual(["p1_000002.wav.part", "p2_000003.wav.part"]);
    const rep = recoverSession(k.dir, { killHrNs: k.killHrNs });
    expect(rep.abnormal_end).toBe(true);
    expect(rep.kill_offset_ms).toBe(5000);
    expect(rep.interrupted.map((i) => [i.fragment_id, i.status, i.fragment_start_offset_ms, i.salvaged_end_offset_ms, i.loss_ms_if_speaking_at_kill])).toEqual([
      ["p1-000002", "salvaged", 2500, 4500, 500],
      ["p2-000003", "salvaged", 4500, 5000, 0],
    ]);
    // p1 stopped talking at 4500 in this synthetic run, so 500 is silence, not loss; the live protocol
    // keeps the reader talking through the kill so the number is a real bound.
    expect(rep.max_loss_ms).toBe(500);
    expect(fs.readdirSync(k.dir).filter((f) => f.endsWith(".part"))).toEqual([]);
    const rec = fs.readFileSync(path.join(k.dir, "p2_000003.recovered.wav"));
    expect(rec.length).toBe(44 + 25 * 960 * 2); // odd trailing byte cut
    expect(parseWavHeader(rec)!.declaredDataBytes).toBe(25 * 960 * 2);
    // Finalized fragment is untouched.
    expect(fs.existsSync(path.join(k.dir, "p1_000001.wav"))).toBe(true);
    const recs = readManifest(k.manifest).records;
    expect(recs.filter((r) => r.type === "fragment_recovered")).toHaveLength(2);
    expect(recs.at(-1)).toMatchObject({ type: "session_stop", reason: "recovered_after_abnormal_end" });
    expect(fs.readdirSync(k.dir).some((f) => /^recovery-.*\.json$/.test(f))).toBe(true);
  });

  it("is idempotent: a second startup finds nothing to do", () => {
    const k = killedSession();
    recoverSession(k.dir, { killHrNs: k.killHrNs });
    const lines = fs.readFileSync(k.manifest, "utf8");
    const rep2 = recoverSession(k.dir);
    expect(rep2.actions).toEqual([]);
    expect(rep2.abnormal_end).toBe(false);
    expect(rep2.interrupted).toEqual([]);
    expect(fs.readFileSync(k.manifest, "utf8")).toBe(lines);
  });

  it("handles an empty .part, a rename that beat its close record, and an open record with no file", () => {
    const k = killedSession();
    // Kill right after rename, before fragment_close: simulate by renaming p1's part to final.
    fs.renameSync(path.join(k.dir, "p1_000002.wav.part"), path.join(k.dir, "p1_000002.wav"));
    // Kill right after the .part header... before any audio: truncate p2 to the bare header.
    fs.truncateSync(path.join(k.dir, "p2_000003.wav.part"), 44);
    // Open record whose file never got created (kill between manifest append and file creation).
    fs.appendFileSync(k.manifest, "\n" + JSON.stringify({ type: "fragment_open", fragment_id: "p1-000004", user_id: P1, label: "p1", epoch: 0, fragment_start_offset_ms: 4990, part_file: "p1_000004.wav.part", t_ms: 4990 }) + "\n");
    const rep = recoverSession(k.dir, { killHrNs: k.killHrNs });
    const by = Object.fromEntries(rep.interrupted.map((i) => [i.fragment_id, i]));
    expect(by["p1-000002"]).toMatchObject({ status: "finalized_unrecorded", samples: 100 * 960 });
    expect(by["p2-000003"]).toMatchObject({ status: "empty", samples: 0, recovered_file: "p2_000003.wav.empty" });
    expect(by["p1-000004"]).toMatchObject({ status: "missing", recovered_file: null });
    // The truncated junk line became a corrupt middle line once we appended after it.
    expect(rep.manifest_corrupt_lines.length).toBe(1);
  });

  it("recoverAll scans every session directory under the output root and ignores clean ones", () => {
    const k = killedSession();
    const clean = makeSession(path.join(k.root, "other-root"), new FakeClock());
    clean.stop();
    const reps = recoverAll(k.root);
    expect(reps).toHaveLength(1);
    expect(reps[0]!.session_dir).toBe(k.dir);
    expect(recoverAll(path.join(k.root, "other-root"))[0]!.actions).toEqual([]);
    expect(recoverAll(path.join(k.root, "does-not-exist"))).toEqual([]);
  });
});
