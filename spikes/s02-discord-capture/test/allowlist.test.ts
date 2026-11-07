import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FakeClock } from "../src/clock.js";
import { Allowlist, TOKEN_ENV, loadConfig, readToken, sessionParamsOf, validateConfig } from "../src/config.js";
import { readManifest } from "../src/manifest.js";
import { CaptureSession } from "../src/session.js";
import { fakeDecoder } from "./helpers.js";
import { P1, STRANGER, makeSession, pkt, talk, tmpDir } from "./helpers.js";

const base = {
  application_id: "200000000000000001",
  guild_id: "200000000000000002",
  gm_user_id: "200000000000000003",
  voice_channel_id: "200000000000000004",
  allowlist: [{ user_id: P1, label: "p1" }],
};
const outside = path.join(os.tmpdir(), "s02-out");
const here = path.dirname(fileURLToPath(import.meta.url));

describe("opt-in allowlist enforcement", () => {
  it("never decodes, writes, or names audio from a user who is not on the allowlist", () => {
    const root = tmpDir();
    const clock = new FakeClock();
    let decoderCalls = 0;
    const s = makeSession(root, clock);
    const origFactory = (s as unknown as { opts: { decoderFactory: () => unknown } }).opts.decoderFactory;
    (s as unknown as { opts: { decoderFactory: () => unknown } }).opts.decoderFactory = () => {
      decoderCalls++;
      return origFactory();
    };
    for (let i = 0; i < 50; i++) {
      expect(s.onPacket(STRANGER, pkt(), clock.nowNs())).toBe("ignored");
      clock.advanceMs(20);
    }
    expect(decoderCalls).toBe(0);
    expect(s.ignoredPacketCount).toBe(50);
    talk(s, clock, P1, 5);
    s.stop();
    const files = fs.readdirSync(s.dir);
    expect(files.filter((f) => f.endsWith(".wav"))).toEqual(["p1_000001.wav"]);
    const manifest = fs.readFileSync(path.join(s.dir, "manifest.jsonl"), "utf8");
    expect(manifest).not.toContain(STRANGER);
    expect(manifest.match(/non_optin_audio_ignored/g)).toHaveLength(1);
  });

  it("Allowlist answers membership and labels", () => {
    const a = new Allowlist([{ user_id: P1, label: "p1" }]);
    expect(a.isOptedIn(P1)).toBe(true);
    expect(a.isOptedIn(STRANGER)).toBe(false);
    expect(a.labelOf(STRANGER)).toBeUndefined();
  });

  it("config requires a non-empty allowlist with unique ids/labels", () => {
    expect(() => validateConfig({ ...base, output_root: outside, allowlist: [] }, { repoProbeDir: os.tmpdir() })).toThrow(/at least one opted-in/);
    expect(() =>
      validateConfig({ ...base, output_root: outside, allowlist: [{ user_id: P1, label: "p1" }, { user_id: P1, label: "p2" }] }, { repoProbeDir: os.tmpdir() }),
    ).toThrow(/duplicate user_id/);
    expect(() => validateConfig({ ...base, output_root: outside, allowlist: [{ user_id: "abc", label: "P 1" }] }, { repoProbeDir: os.tmpdir() })).toThrow(/user_id invalid[\s\S]*label must match/);
    const ok = validateConfig({ ...base, output_root: outside }, { repoProbeDir: os.tmpdir() });
    expect(ok.silence_close_ms).toBe(1000);
  });

  it("config rejects a token in the file and an output_root inside the git repo", () => {
    expect(() => validateConfig({ ...base, output_root: outside, token: "x" }, { repoProbeDir: os.tmpdir() })).toThrow(new RegExp(TOKEN_ENV));
    expect(() => validateConfig({ ...base, output_root: path.join(here, "..", "recordings") }, { repoProbeDir: here })).toThrow(/outside the git repository/);
  });

  it("output_root safeguard holds when the config file lives outside the checkout", () => {
    const cfgDir = tmpDir();
    const cfgFile = path.join(cfgDir, "s02.config.json");
    const inside = path.join(here, "..", "recordings-test-should-not-exist");
    fs.writeFileSync(cfgFile, JSON.stringify({ ...base, output_root: inside }));
    expect(() => loadConfig(cfgFile)).toThrow(/outside the git repository/);
    // Probe dir outside the repo (e.g. cwd elsewhere): the output path itself still locates the checkout.
    expect(() => validateConfig({ ...base, output_root: inside }, { repoProbeDir: os.tmpdir() })).toThrow(/outside the git repository/);
    fs.writeFileSync(cfgFile, JSON.stringify({ ...base, output_root: outside }));
    expect(loadConfig(cfgFile).output_root).toBe(outside);
  });

  it("session_start.params holds only numeric session parameters, never config IDs or paths", () => {
    const cfg = validateConfig({ ...base, output_root: outside }, { repoProbeDir: os.tmpdir() });
    const params = sessionParamsOf(cfg);
    expect(Object.keys(params).sort()).toEqual(["flush_interval_ms", "gap_fill_threshold_ms", "latency_compensation_ms", "max_fragment_ms", "silence_close_ms"]);
    // Even if a caller passes the whole config, CaptureSession must not serialize it.
    const root = tmpDir();
    const s = new CaptureSession({
      outputRoot: root,
      sessionId: "s02-params",
      clock: new FakeClock(),
      allowlist: new Allowlist(cfg.allowlist),
      params: cfg,
      decoderFactory: fakeDecoder,
    });
    s.stop();
    const text = fs.readFileSync(path.join(s.dir, "manifest.jsonl"), "utf8");
    for (const id of [base.gm_user_id, base.guild_id, base.application_id, base.voice_channel_id]) expect(text).not.toContain(id);
    expect(text).not.toContain("s02-out");
    const start = readManifest(path.join(s.dir, "manifest.jsonl")).records[0]!;
    expect(start.type === "session_start" && start.params).toEqual(params);
  });

  it("events after stop are ignored instead of writing to the closed manifest", () => {
    const s = makeSession(tmpDir(), new FakeClock());
    s.stop();
    expect(() => s.event("late_callback", {})).not.toThrow();
    expect(() => s.beginDiscontinuity("late")).not.toThrow();
    const text = fs.readFileSync(path.join(s.dir, "manifest.jsonl"), "utf8");
    expect(text).not.toContain("late_callback");
    expect(text).not.toContain("discontinuity_start");
  });

  it("token comes only from the environment", () => {
    expect(() => readToken({})).toThrow(new RegExp(TOKEN_ENV));
    expect(readToken({ [TOKEN_ENV]: "  abc  " })).toBe("abc");
  });
});
