/**
 * Minimal RIFF/WAVE header reader: enough to get an exact duration for
 * PCM WAV files (what the GM should feed whisper.cpp anyway).
 */
import { open } from "node:fs/promises";

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  byteRate: number;
  dataBytes: number;
  durationMs: number;
}

export function parseWavHeader(buf: Buffer, fileSize?: number): WavInfo {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not a RIFF/WAVE file");
  }
  let off = 12;
  let fmt: { channels: number; sampleRate: number; byteRate: number; bitsPerSample: number } | null = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt ") {
      if (body + 16 > buf.length) break;
      fmt = {
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        byteRate: buf.readUInt32LE(body + 8),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      if (!fmt) throw new Error("WAV: data chunk before fmt chunk");
      if (fmt.byteRate === 0) throw new Error("WAV: byteRate is 0");
      let dataBytes = size;
      // Streaming writers sometimes leave 0 / 0xFFFFFFFF; fall back to file size.
      if ((size === 0 || size === 0xffffffff) && fileSize !== undefined) dataBytes = fileSize - body;
      return { ...fmt, dataBytes, durationMs: Math.round((dataBytes * 1000) / fmt.byteRate) };
    }
    off = body + size + (size % 2); // chunks are word-aligned
  }
  throw new Error("WAV: no data chunk found in header region");
}

export async function readWavInfo(file: string): Promise<WavInfo> {
  const fh = await open(file, "r");
  try {
    const { size } = await fh.stat();
    const len = Math.min(size, 1 << 20);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, 0);
    return parseWavHeader(buf, size);
  } finally {
    await fh.close();
  }
}

/** Build a silent PCM s16 mono WAV buffer (used only by tests). */
export function makeSilentWav(durationMs: number, sampleRate = 16000): Buffer {
  const samples = Math.round((durationMs * sampleRate) / 1000);
  const dataBytes = samples * 2;
  const b = Buffer.alloc(44 + dataBytes);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(36 + dataBytes, 4);
  b.write("WAVE", 8, "ascii");
  b.write("fmt ", 12, "ascii");
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(1, 22); // mono
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36, "ascii");
  b.writeUInt32LE(dataBytes, 40);
  return b;
}
