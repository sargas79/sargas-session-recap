import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { FragmentWriter, renameWithRetry } from "../src/fragment-writer.js";
import { readManifest } from "../src/manifest.js";
import { parseWavHeader } from "../src/wav.js";
import { FakeClock } from "../src/clock.js";
import { P1, makeSession, talk, tmpDir } from "./helpers.js";

const fmt = { sampleRate: 48_000, channels: 1 };

describe("fragment finalization / rename", () => {
  it("writes to .part while open and renames to final with a correct header on finalize", () => {
    const dir = tmpDir();
    const w = new FragmentWriter(dir, "p1_000001", fmt, 1000, () => 0);
    w.write(new Int16Array(960).fill(7));
    w.write(new Int16Array(480).fill(-7));
    expect(fs.existsSync(path.join(dir, "p1_000001.wav.part"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "p1_000001.wav"))).toBe(false);
    const final = w.finalize();
    expect(final).toBe(path.join(dir, "p1_000001.wav"));
    expect(fs.existsSync(path.join(dir, "p1_000001.wav.part"))).toBe(false);
    const buf = fs.readFileSync(final);
    expect(buf.length).toBe(44 + 1440 * 2);
    const h = parseWavHeader(buf)!;
    expect(h).toEqual({ sampleRate: 48_000, channels: 1, declaredDataBytes: 2880 });
    expect(buf.readUInt32LE(4)).toBe(36 + 2880);
    expect(buf.readInt16LE(44)).toBe(7);
    expect(buf.readInt16LE(44 + 960 * 2)).toBe(-7);
  });

  it("refuses to overwrite an existing .part and to finalize twice", () => {
    const dir = tmpDir();
    const w = new FragmentWriter(dir, "x", fmt, 1000, () => 0);
    expect(() => new FragmentWriter(dir, "x", fmt, 1000, () => 0)).toThrow();
    w.finalize();
    expect(() => w.finalize()).toThrow(/already finalized/);
    expect(() => w.write(new Int16Array(1))).toThrow(/already finalized/);
  });

  it("retries rename on transient Windows errors (EBUSY/EPERM) and then succeeds", () => {
    let calls = 0;
    const attempts = renameWithRetry("a", "b", {
      baseDelayMs: 1,
      rename: () => {
        calls++;
        if (calls < 3) throw Object.assign(new Error("busy"), { code: calls === 1 ? "EBUSY" : "EPERM" });
      },
    });
    expect(attempts).toBe(3);
  });

  it("gives up after bounded attempts and does not retry non-transient errors", () => {
    let calls = 0;
    const busy = () => {
      calls++;
      throw Object.assign(new Error("busy"), { code: "EBUSY" });
    };
    expect(() => renameWithRetry("a", "b", { attempts: 4, baseDelayMs: 1, rename: busy })).toThrow(/busy/);
    expect(calls).toBe(4);
    calls = 0;
    const missing = () => {
      calls++;
      throw Object.assign(new Error("nope"), { code: "ENOENT" });
    };
    expect(() => renameWithRetry("a", "b", { baseDelayMs: 1, rename: missing })).toThrow(/nope/);
    expect(calls).toBe(1);
  });

  it("session writes fragment_open before the .part exists and fragment_close only after the rename", () => {
    const root = tmpDir();
    const clock = new FakeClock();
    const s = makeSession(root, clock);
    talk(s, clock, P1, 10);
    const mPath = path.join(s.dir, "manifest.jsonl");
    let recs = readManifest(mPath).records;
    expect(recs.filter((r) => r.type === "fragment_open")).toHaveLength(1);
    expect(recs.filter((r) => r.type === "fragment_close")).toHaveLength(0);
    expect(fs.existsSync(path.join(s.dir, "p1_000001.wav.part"))).toBe(true);
    s.onStreamEnd(P1);
    recs = readManifest(mPath).records;
    const close = recs.find((r) => r.type === "fragment_close");
    expect(close).toMatchObject({ final_file: "p1_000001.wav", end_reason: "silence", samples: 9600, duration_ms: 200, packets: 10 });
    expect(fs.existsSync(path.join(s.dir, "p1_000001.wav"))).toBe(true);
    expect(fs.readdirSync(s.dir).filter((f) => f.endsWith(".part"))).toEqual([]);
    s.stop();
    expect(readManifest(mPath).records.at(-1)).toMatchObject({ type: "session_stop" });
  });

  it("rotates fragments at max_fragment_ms and finalizes all open fragments on stop", () => {
    const root = tmpDir();
    const clock = new FakeClock();
    const s = makeSession(root, clock, { max_fragment_ms: 1000 });
    talk(s, clock, P1, 120); // 2.4 s
    s.stop();
    const recs = readManifest(path.join(s.dir, "manifest.jsonl")).records;
    const closes = recs.filter((r) => r.type === "fragment_close");
    expect(closes.map((c) => c.type === "fragment_close" && c.end_reason)).toEqual(["rotate", "rotate", "stop"]);
    expect(fs.readdirSync(s.dir).filter((f) => f.endsWith(".part"))).toEqual([]);
  });

  it("counts decode errors without writing audio for the bad packet", () => {
    const root = tmpDir();
    const clock = new FakeClock();
    const s = makeSession(root, clock);
    s.onPacket(P1, Buffer.alloc(0), clock.nowNs());
    talk(s, clock, P1, 2);
    s.stop();
    const close = readManifest(path.join(s.dir, "manifest.jsonl")).records.find((r) => r.type === "fragment_close");
    expect(close).toMatchObject({ packets: 3, decode_errors: 1, samples: 1920 });
  });
});
