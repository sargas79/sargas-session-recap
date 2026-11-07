import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FakeClock, type Clock } from "../src/clock.js";
import { Allowlist } from "../src/config.js";
import { FRAME_SAMPLES } from "../src/offsets.js";
import { CaptureSession, type Decoder, type SessionParams } from "../src/session.js";

export const P1 = "100000000000000001";
export const P2 = "100000000000000002";
export const STRANGER = "999999999999999999";

export const PARAMS: SessionParams = {
  silence_close_ms: 1000,
  gap_fill_threshold_ms: 100,
  latency_compensation_ms: 0,
  max_fragment_ms: 30_000,
  flush_interval_ms: 1000,
};

export function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "s02-test-"));
}

/** Fake "Opus": byte 0..1 = sample value repeated for one 20 ms frame; empty buffer = decode error. */
export const fakeDecoder = (): Decoder => ({
  decode(opus: Buffer): Int16Array {
    if (opus.length < 2) throw new Error("bad packet");
    return new Int16Array(FRAME_SAMPLES).fill(opus.readInt16LE(0));
  },
});

export function pkt(v = 1000): Buffer {
  const b = Buffer.alloc(2);
  b.writeInt16LE(v);
  return b;
}

export function makeSession(root: string, clock: Clock = new FakeClock(), params: Partial<SessionParams> = {}) {
  return new CaptureSession({
    outputRoot: root,
    sessionId: "s02-test",
    clock,
    allowlist: new Allowlist([
      { user_id: P1, label: "p1" },
      { user_id: P2, label: "p2" },
    ]),
    params: { ...PARAMS, ...params },
    decoderFactory: fakeDecoder,
  });
}

/** Feeds `n` packets 20 ms apart, advancing the fake clock. */
export function talk(s: CaptureSession, clock: FakeClock, user: string, n: number, v = 1000): void {
  for (let i = 0; i < n; i++) {
    s.onPacket(user, pkt(v), clock.nowNs());
    clock.advanceMs(20);
  }
}
