/** Minimal 16-bit PCM WAV header helpers (THROWAWAY spike). */
export const WAV_HEADER_BYTES = 44;

export interface PcmFormat {
  sampleRate: number;
  channels: number;
}

export function wavHeader(dataBytes: number, fmt: PcmFormat): Buffer {
  const blockAlign = fmt.channels * 2;
  const h = Buffer.alloc(WAV_HEADER_BYTES);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(fmt.channels, 22);
  h.writeUInt32LE(fmt.sampleRate, 24);
  h.writeUInt32LE(fmt.sampleRate * blockAlign, 28);
  h.writeUInt16LE(blockAlign, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

export interface ParsedWav {
  sampleRate: number;
  channels: number;
  declaredDataBytes: number;
}

export function parseWavHeader(buf: Buffer): ParsedWav | null {
  if (buf.length < WAV_HEADER_BYTES) return null;
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return null;
  if (buf.toString("ascii", 36, 40) !== "data") return null;
  return {
    channels: buf.readUInt16LE(22),
    sampleRate: buf.readUInt32LE(24),
    declaredDataBytes: buf.readUInt32LE(40),
  };
}
