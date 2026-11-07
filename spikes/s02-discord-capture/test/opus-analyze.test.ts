import OpusScript from "opusscript";
import { describe, expect, it } from "vitest";
import { FakeClock } from "../src/clock.js";
import { analyzeSession, findToneOnset } from "../src/analyze.js";
import { beepOpusPackets, createOpusDecoder, downmixStereo } from "../src/opus.js";
import { FRAME_SAMPLES } from "../src/offsets.js";
import { Allowlist } from "../src/config.js";
import { CaptureSession } from "../src/session.js";
import { P1, P2, PARAMS, tmpDir } from "./helpers.js";

function silenceOpus(): Buffer {
  const enc = new OpusScript(48_000, 2, OpusScript.Application.AUDIO);
  const b = Buffer.from(enc.encode(Buffer.alloc(FRAME_SAMPLES * 4), FRAME_SAMPLES));
  enc.delete();
  return b;
}

describe("opus decode + reference beep analysis (offline)", () => {
  it("downmixes stereo to mono", () => {
    expect([...downmixStereo(Int16Array.from([100, 300, -2, -4]))]).toEqual([200, -3]);
  });

  it("opusscript round-trips the reference beep and the onset detector finds it", () => {
    const dec = createOpusDecoder();
    const sil = silenceOpus();
    const frames = [...Array(10).fill(sil), ...beepOpusPackets(300)];
    const pcm = frames.flatMap((p) => [...dec.decode(p)]);
    const onset = findToneOnset(Int16Array.from(pcm));
    expect(onset).not.toBeNull();
    // Beep starts at frame 10 = 200 ms; Opus codec delay/attack shifts it by a few ms at most.
    expect(Math.abs((onset! * 1000) / 48_000 - 200)).toBeLessThanOrEqual(20);
    expect(findToneOnset(Int16Array.from([...dec.decode(sil)]))).toBeNull();
  });

  it("analyzeSession reports per-speaker beep onsets on the session timeline and their spread", () => {
    const root = tmpDir();
    const clock = new FakeClock();
    const s = new CaptureSession({
      outputRoot: root,
      sessionId: "s02-analyze",
      clock,
      allowlist: new Allowlist([
        { user_id: P1, label: "p1" },
        { user_id: P2, label: "p2" },
      ]),
      params: PARAMS,
      decoderFactory: createOpusDecoder,
    });
    const sil = silenceOpus();
    const beep = beepOpusPackets(300);
    clock.advanceMs(1000);
    s.mark("ref1");
    s.event("mark_beep_playing", { label: "ref1" });
    // p1 hears the beep 140 ms after play, p2 200 ms after (different acoustic/network paths).
    const p1 = [...Array(7).fill(sil), ...beep, sil, sil];
    const p2 = [...Array(10).fill(sil), ...beep, sil, sil];
    for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
      if (p1[i]) s.onPacket(P1, p1[i], clock.nowNs());
      if (p2[i]) s.onPacket(P2, p2[i], clock.nowNs());
      clock.advanceMs(20);
    }
    s.stop();
    const [r] = analyzeSession(s.dir);
    expect(r!.label).toBe("ref1");
    expect(r!.beep_play_t_ms).toBe(1000);
    const d = Object.fromEntries(r!.onsets.map((o) => [o.speaker, o.delta_ms]));
    expect(Math.abs(d.p1! - 140)).toBeLessThanOrEqual(20);
    expect(Math.abs(d.p2! - 200)).toBeLessThanOrEqual(20);
    expect(Math.abs(r!.spread_ms! - 60)).toBeLessThanOrEqual(20);
  });
});
