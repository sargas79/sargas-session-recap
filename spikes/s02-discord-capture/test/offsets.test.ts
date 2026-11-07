import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { FakeClock, nsToMs } from "../src/clock.js";
import { readManifest, type ManifestRecord } from "../src/manifest.js";
import { FRAME_SAMPLES, FragmentTimeline, fragmentStartOffsetMs } from "../src/offsets.js";
import { readWavMono } from "../src/analyze.js";
import { P1, P2, makeSession, talk, tmpDir } from "./helpers.js";

const ms = (x: number) => BigInt(x) * 1_000_000n;
type Open = Extract<ManifestRecord, { type: "fragment_open" }>;
type Close = Extract<ManifestRecord, { type: "fragment_close" }>;

function frags(dir: string) {
  const recs = readManifest(path.join(dir, "manifest.jsonl")).records;
  const opens = recs.filter((r): r is Open => r.type === "fragment_open");
  const closes = recs.filter((r): r is Close => r.type === "fragment_close");
  return { recs, opens, closes };
}

describe("fragment_start_offset_ms (s02-arrival-anchor/1)", () => {
  it("rule 2: anchors at first-packet arrival on the session clock, minus latency compensation, clamped at 0", () => {
    expect(fragmentStartOffsetMs(ms(1000), ms(1000) + 1_234_567_890n, 0)).toBe(1235);
    expect(fragmentStartOffsetMs(ms(1000), ms(1500), 120)).toBe(380);
    expect(fragmentStartOffsetMs(ms(1000), ms(1050), 120)).toBe(0);
    expect(nsToMs(-1_500_000n)).toBe(-2);
  });

  it("rule 3: fills an intra-fragment gap larger than the threshold with whole frames of silence", () => {
    const t0 = ms(0);
    const tl = new FragmentTimeline(t0, ms(500), { gapFillThresholdMs: 100, latencyCompensationMs: 0 });
    expect(tl.padBefore(ms(500))).toBe(0);
    tl.commit(FRAME_SAMPLES); // covers 500..520
    expect(tl.padBefore(ms(540))).toBe(0); // 20 ms late: jitter, not filled
    tl.commit(FRAME_SAMPLES); // 520..540 in sample time
    const pad = tl.padBefore(ms(800)); // expected 540, drift 260 ms -> 13 frames
    expect(pad).toBe(13 * FRAME_SAMPLES);
    tl.commit(FRAME_SAMPLES);
    expect(tl.endOffsetMs).toBe(500 + 16 * 20); // 2 frames + 13 filled + 1 frame
    // Early (bursty) packets are never corrected, only recorded: expected 820, arrived 750.
    expect(tl.padBefore(ms(750))).toBe(0);
    expect(tl.stats()).toEqual({ gap_fill_count: 1, gap_fill_ms: 260, max_early_ms: 70 });
  });

  it("keeps sample positions aligned with arrival after an intra-fragment pause", () => {
    const root = tmpDir();
    const clock = new FakeClock();
    const s = makeSession(root, clock);
    clock.advanceMs(1000);
    talk(s, clock, P1, 10, 100); // 1000..1200
    clock.advanceMs(400); // pause shorter than silence_close_ms, stream stays open
    talk(s, clock, P1, 5, 200); // should land at 1600
    s.stop();
    const { opens, closes } = frags(s.dir);
    expect(opens).toHaveLength(1);
    expect(opens[0]!.fragment_start_offset_ms).toBe(1000);
    const x = readWavMono(path.join(s.dir, closes[0]!.final_file));
    const firstLoud = x.findIndex((v, i) => i > 0 && v === 200);
    expect(1000 + (firstLoud * 1000) / 48_000).toBe(1600);
    expect(closes[0]).toMatchObject({ gap_fill_count: 1, gap_fill_ms: 400, duration_ms: 700, end_offset_ms: 1700 });
  });

  it("rule 2+3: a late first valid frame after leading decode errors is gap-filled, not pulled early", () => {
    const root = tmpDir();
    const clock = new FakeClock();
    const s = makeSession(root, clock);
    clock.advanceMs(1000);
    s.onPacket(P1, Buffer.alloc(0), clock.nowNs()); // opens the fragment (anchor 1000), fails to decode
    clock.advanceMs(500);
    talk(s, clock, P1, 5, 300); // first valid frame arrives at 1500
    s.stop();
    const { opens, closes } = frags(s.dir);
    expect(opens[0]!.fragment_start_offset_ms).toBe(1000);
    const x = readWavMono(path.join(s.dir, closes[0]!.final_file));
    const firstLoud = x.findIndex((v) => v === 300);
    expect(1000 + (firstLoud * 1000) / 48_000).toBe(1500);
    expect(closes[0]).toMatchObject({ decode_errors: 1, gap_fill_count: 1, gap_fill_ms: 500 });
  });

  it("rule 4: long silence ends the fragment; the next fragment re-anchors without accumulating drift", () => {
    const root = tmpDir();
    const clock = new FakeClock();
    const s = makeSession(root, clock);
    clock.advanceMs(250);
    talk(s, clock, P1, 50); // 250..1250
    clock.advanceMs(1000);
    s.onStreamEnd(P1); // receive stream ended after silence_close_ms
    clock.advanceMs(10 * 60_000 - 1000 + 7); // ~10 minutes of silence
    talk(s, clock, P1, 5);
    talk(s, clock, P2, 5); // P2 starts right after: separate track, own anchor
    s.stop();
    const { opens, closes } = frags(s.dir);
    expect(opens.map((o) => [o.label, o.fragment_start_offset_ms])).toEqual([
      ["p1", 250],
      ["p1", 250 + 1000 + 1000 + 10 * 60_000 - 1000 + 7],
      ["p2", 250 + 1000 + 1000 + 10 * 60_000 - 1000 + 7 + 100],
    ]);
    expect(closes.map((c) => c.end_reason)).toEqual(["silence", "stop", "stop"]);
    expect(closes.every((c) => c.gap_fill_count === 0)).toBe(true);
  });

  it("simultaneous speakers get independent tracks with independent anchors", () => {
    const root = tmpDir();
    const clock = new FakeClock();
    const s = makeSession(root, clock);
    clock.advanceMs(100);
    for (let i = 0; i < 20; i++) {
      s.onPacket(P1, Buffer.from([1, 0]), clock.nowNs());
      clock.advanceMs(7);
      if (i >= 3) s.onPacket(P2, Buffer.from([2, 0]), clock.nowNs());
      clock.advanceMs(13);
    }
    s.stop();
    const { opens, closes } = frags(s.dir);
    expect(opens.map((o) => [o.label, o.fragment_start_offset_ms])).toEqual([
      ["p1", 100],
      ["p2", 100 + 3 * 20 + 7],
    ]);
    expect(closes.map((c) => c.samples)).toEqual([20 * FRAME_SAMPLES, 17 * FRAME_SAMPLES]);
    const x1 = readWavMono(path.join(s.dir, closes[0]!.final_file));
    const x2 = readWavMono(path.join(s.dir, closes[1]!.final_file));
    expect(x1.every((v) => v === 1)).toBe(true);
    expect(x2.every((v) => v === 2)).toBe(true);
  });

  it("rule 6: reconnect closes open fragments, bumps the epoch and keeps the same session clock", () => {
    const root = tmpDir();
    const clock = new FakeClock();
    const s = makeSession(root, clock);
    clock.advanceMs(1000);
    talk(s, clock, P1, 25); // 1000..1500
    s.beginDiscontinuity("connection ready->disconnected");
    expect(s.openFragmentCount()).toBe(0);
    clock.advanceMs(4500); // disconnected 1500..6000
    s.endDiscontinuity();
    talk(s, clock, P1, 10); // 6000..6200
    s.stop();
    const { recs, opens, closes } = frags(s.dir);
    expect(opens.map((o) => [o.fragment_start_offset_ms, o.epoch])).toEqual([
      [1000, 0],
      [6000, 1],
    ]);
    expect(closes[0]).toMatchObject({ end_reason: "discontinuity", end_offset_ms: 1500 });
    const start = recs.find((r) => r.type === "event" && r.event === "discontinuity_start");
    const end = recs.find((r) => r.type === "event" && r.event === "discontinuity_end");
    expect(start).toMatchObject({ t_ms: 1500, new_epoch: 1 });
    expect(end).toMatchObject({ t_ms: 6000, start_ms: 1500, gap_ms: 4500, epoch: 1 });
    // No gap fill across the discontinuity: the new fragment is anchored, not padded.
    expect(closes[1]).toMatchObject({ gap_fill_count: 0, end_offset_ms: 6200 });
    // Only one session_start: t0 never reset.
    expect(recs.filter((r) => r.type === "session_start")).toHaveLength(1);
  });

  it("marks and events carry monotonic session timestamps", () => {
    const root = tmpDir();
    const clock = new FakeClock();
    const s = makeSession(root, clock);
    clock.advanceMs(42);
    expect(s.mark("clap1")).toBe(42);
    clock.advanceMs(8);
    s.event("member_join", { label: "p1" });
    s.stop();
    const ev = frags(s.dir).recs.filter((r) => r.type === "event");
    expect(ev.map((e) => [e.type === "event" && e.event, e.type === "event" && e.t_ms])).toEqual([
      ["mark", 42],
      ["member_join", 50],
    ]);
  });
});
