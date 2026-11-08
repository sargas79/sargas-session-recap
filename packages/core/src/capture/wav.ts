/**
 * Pure-JS RIFF/WAVE header reader (T05).
 *
 * Reads only chunk headers, never the samples, so a multi-hour WAV costs a few small reads. It
 * understands 16-bit integer PCM (`WAVE_FORMAT_PCM` and `WAVE_FORMAT_EXTENSIBLE` with the PCM
 * sub-format), which is what multitrack recorders export as WAV. Anything else (RF64, float,
 * 24-bit, compressed WAV) returns `undefined`, and the importer falls back to ffprobe, which then
 * reports the codec. This lets a WAV-only import run without ffmpeg installed.
 */
import { open } from 'node:fs/promises';
import type { AudioProbe } from '../audio/index.ts';

const WAVE_FORMAT_PCM = 0x0001;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;
/** KSDATAFORMAT_SUBTYPE_PCM after its first two bytes (which hold the format tag, 0x0001). */
const PCM_SUBFORMAT_TAIL = Buffer.from('000000001000800000aa00389b71', 'hex');
/** Never walk more chunk headers than this (a corrupt file cannot make us loop). */
const MAX_CHUNKS = 64;

interface Fmt {
  readonly format: number;
  readonly channels: number;
  readonly sampleRate: number;
  readonly blockAlign: number;
  readonly bitsPerSample: number;
}

function parseFmt(body: Buffer): Fmt | undefined {
  if (body.length < 16) return undefined;
  let format = body.readUInt16LE(0);
  const channels = body.readUInt16LE(2);
  const sampleRate = body.readUInt32LE(4);
  const blockAlign = body.readUInt16LE(12);
  const bitsPerSample = body.readUInt16LE(14);
  if (format === WAVE_FORMAT_EXTENSIBLE) {
    if (body.length < 40) return undefined;
    const sub = body.subarray(24, 40);
    if (sub.readUInt16LE(0) !== WAVE_FORMAT_PCM || !sub.subarray(2).equals(PCM_SUBFORMAT_TAIL)) {
      return undefined;
    }
    format = WAVE_FORMAT_PCM;
  }
  return { format, channels, sampleRate, blockAlign, bitsPerSample };
}

/**
 * Probes a 16-bit PCM WAV file from its header. Returns `undefined` for anything that is not a
 * plain RIFF/WAVE 16-bit PCM file (the caller then uses ffprobe).
 */
export async function probeWavHeader(file: string): Promise<AudioProbe | undefined> {
  const handle = await open(file, 'r');
  try {
    const size = (await handle.stat()).size;
    const head = Buffer.alloc(12);
    if ((await handle.read(head, 0, 12, 0)).bytesRead < 12) return undefined;
    if (head.toString('latin1', 0, 4) !== 'RIFF' || head.toString('latin1', 8, 12) !== 'WAVE') {
      return undefined;
    }
    let offset = 12;
    let fmt: Fmt | undefined;
    for (let i = 0; i < MAX_CHUNKS && offset + 8 <= size; i += 1) {
      const header = Buffer.alloc(8);
      await handle.read(header, 0, 8, offset);
      const id = header.toString('latin1', 0, 4);
      const declared = header.readUInt32LE(4);
      const bodyStart = offset + 8;
      if (id === 'fmt ') {
        const length = Math.min(declared, 64);
        const body = Buffer.alloc(length);
        await handle.read(body, 0, length, bodyStart);
        fmt = parseFmt(body);
        if (fmt === undefined) return undefined;
      } else if (id === 'data') {
        if (fmt === undefined) return undefined;
        if (fmt.format !== WAVE_FORMAT_PCM || fmt.bitsPerSample !== 16) return undefined;
        if (fmt.channels < 1 || fmt.sampleRate < 1) return undefined;
        if (fmt.blockAlign !== fmt.channels * 2) return undefined;
        // Streaming writers leave 0 or 0xFFFFFFFF when they never patched the header: use what
        // is actually on disk. A declared size past the end means a truncated file; same rule.
        const available = size - bodyStart;
        const dataBytes =
          declared === 0 || declared === 0xffffffff || declared > available ? available : declared;
        const sampleCount = Math.floor(dataBytes / fmt.blockAlign);
        return {
          codec: 'pcm_s16le',
          sampleRate: fmt.sampleRate,
          channels: fmt.channels,
          sampleCount,
          // Rounded like probeAudio (fragments use floor, computed by the importer).
          durationMs: Math.round((sampleCount * 1000) / fmt.sampleRate),
        };
      }
      // Chunks are padded to an even length.
      offset = bodyStart + declared + (declared % 2);
    }
    return undefined;
  } finally {
    await handle.close();
  }
}
