/**
 * Opus decode/encode via opusscript (pure JS/WASM, no native build on Windows). THROWAWAY spike.
 * Discord sends 48 kHz stereo Opus; we downmix to mono for storage.
 */
import OpusScript from "opusscript";
import type { Decoder } from "./session.js";
import { FRAME_SAMPLES, SAMPLE_RATE } from "./offsets.js";

export function downmixStereo(interleaved: Int16Array): Int16Array {
  const n = interleaved.length >> 1;
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = (interleaved[2 * i]! + interleaved[2 * i + 1]!) >> 1;
  return out;
}

export function createOpusDecoder(): Decoder {
  const dec = new OpusScript(SAMPLE_RATE, 2, OpusScript.Application.VOIP);
  return {
    decode(opus: Buffer): Int16Array {
      const out = dec.decode(opus);
      const stereo = new Int16Array(out.buffer, out.byteOffset, out.byteLength >> 1);
      return downmixStereo(stereo);
    },
  };
}

/** Reference beep for /spike mark: 1 kHz sine, `ms` long, as 20 ms Opus packets (stereo). */
export function beepOpusPackets(ms = 300, freqHz = 1000, amplitude = 0.5): Buffer[] {
  const enc = new OpusScript(SAMPLE_RATE, 2, OpusScript.Application.AUDIO);
  const frames = Math.ceil(ms / 20);
  const packets: Buffer[] = [];
  for (let f = 0; f < frames; f++) {
    const pcm = Buffer.alloc(FRAME_SAMPLES * 4);
    for (let i = 0; i < FRAME_SAMPLES; i++) {
      const t = (f * FRAME_SAMPLES + i) / SAMPLE_RATE;
      const v = Math.round(Math.sin(2 * Math.PI * freqHz * t) * amplitude * 32767);
      pcm.writeInt16LE(v, i * 4);
      pcm.writeInt16LE(v, i * 4 + 2);
    }
    packets.push(Buffer.from(enc.encode(pcm, FRAME_SAMPLES)));
  }
  enc.delete();
  return packets;
}
