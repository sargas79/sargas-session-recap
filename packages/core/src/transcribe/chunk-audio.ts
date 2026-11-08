/**
 * Builds one chunk's 16 kHz mono WAV for whisper from fragments already decoded to 16 kHz PCM.
 *
 * The T08 map holds only if each piece occupies exactly `duration_ms` of the chunk audio. At
 * 16 kHz one millisecond is exactly 16 samples, so slicing the decoded PCM by integer offsets gives
 * that exactly; asking ffmpeg to seek per piece would not.
 */
import { open, type FileHandle } from 'node:fs/promises';
import { StageError } from '../jobs/errors.ts';

const SAMPLES_PER_MS = 16;
const BYTES_PER_SAMPLE = 2;
const WAV_HEADER_BYTES = 44;
const COPY_BUFFER_BYTES = 1 << 20;
const MAX_WAV_CHUNKS = 64;

/**
 * whisper.cpp v1.9.5 skips input under 100 ms and returns no text, which would lose a very short
 * utterance, so such chunks get trailing silence. Past the end of the map: no chunk time moves.
 */
export const MIN_WHISPER_AUDIO_MS = 200;

/** Resampling can end a decoded fragment slightly early; more than this means a bad decode. */
export const MAX_DECODE_SHORTFALL_MS = 250;

export interface ChunkAudioPiece {
  /** The fragment decoded to 16 kHz mono PCM WAV. */
  readonly file: string;
  /** From the start of the fragment. */
  readonly startMs: number;
  readonly durationMs: number;
}

interface PcmLayout {
  readonly dataOffset: number;
  readonly dataBytes: number;
}

function audioError(message: string): StageError {
  return new StageError('chunk-audio-invalid', message);
}

async function readPcmLayout(handle: FileHandle): Promise<PcmLayout> {
  const size = (await handle.stat()).size;
  const riff = Buffer.alloc(12);
  await handle.read(riff, 0, 12, 0);
  if (riff.toString('latin1', 0, 4) !== 'RIFF' || riff.toString('latin1', 8, 12) !== 'WAVE') {
    throw audioError('a decoded fragment is not a WAV file');
  }
  let offset = 12;
  let formatChecked = false;
  for (let i = 0; i < MAX_WAV_CHUNKS && offset + 8 <= size; i += 1) {
    const header = Buffer.alloc(8);
    await handle.read(header, 0, 8, offset);
    const id = header.toString('latin1', 0, 4);
    const declared = header.readUInt32LE(4);
    const bodyStart = offset + 8;
    if (id === 'fmt ') {
      const fmt = Buffer.alloc(16);
      await handle.read(fmt, 0, 16, bodyStart);
      if (
        fmt.readUInt16LE(2) !== 1 ||
        fmt.readUInt32LE(4) !== 16_000 ||
        fmt.readUInt16LE(14) !== 16
      ) {
        throw audioError('a decoded fragment is not 16 kHz mono 16-bit PCM');
      }
      formatChecked = true;
    } else if (id === 'data') {
      if (!formatChecked) throw audioError('a decoded fragment has no format chunk');
      const available = size - bodyStart;
      return {
        dataOffset: bodyStart,
        dataBytes: declared > available || declared === 0 ? available : declared,
      };
    }
    offset = bodyStart + declared + (declared % 2);
  }
  throw audioError('a decoded fragment has no audio data');
}

function wavHeader(dataBytes: number): Buffer {
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(WAV_HEADER_BYTES - 8 + dataBytes, 4);
  header.write('WAVE', 8, 'latin1');
  header.write('fmt ', 12, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16_000, 24);
  header.writeUInt32LE(16_000 * BYTES_PER_SAMPLE, 28);
  header.writeUInt16LE(BYTES_PER_SAMPLE, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

async function writeZeros(out: FileHandle, bytes: number): Promise<void> {
  const zeros = Buffer.alloc(Math.min(bytes, COPY_BUFFER_BYTES));
  for (let left = bytes; left > 0; left -= zeros.length) {
    await out.write(zeros, 0, Math.min(left, zeros.length));
  }
}

async function copyPiece(out: FileHandle, piece: ChunkAudioPiece): Promise<void> {
  const wanted = piece.durationMs * SAMPLES_PER_MS * BYTES_PER_SAMPLE;
  const source = await open(piece.file, 'r');
  try {
    const layout = await readPcmLayout(source);
    const start = piece.startMs * SAMPLES_PER_MS * BYTES_PER_SAMPLE;
    const available = Math.max(0, Math.min(wanted, layout.dataBytes - start));
    const shortfall = wanted - available;
    const allowed = MAX_DECODE_SHORTFALL_MS * SAMPLES_PER_MS * BYTES_PER_SAMPLE;
    if (shortfall > allowed) {
      throw new StageError(
        'chunk-audio-short',
        'a decoded fragment is shorter than its chunk plan expects; re-run chunk planning or check the audio file',
      );
    }
    const buffer = Buffer.alloc(Math.min(COPY_BUFFER_BYTES, Math.max(available, 1)));
    for (let done = 0; done < available;) {
      const length = Math.min(buffer.length, available - done);
      const { bytesRead } = await source.read(buffer, 0, length, layout.dataOffset + start + done);
      if (bytesRead === 0) throw audioError('a decoded fragment ended while being read');
      await out.write(buffer, 0, bytesRead);
      done += bytesRead;
    }
    await writeZeros(out, shortfall);
  } finally {
    await source.close();
  }
}

/** Writes the chunk WAV: the pieces in order, each exactly its `durationMs`. */
export async function writeChunkWav(
  target: string,
  pieces: readonly ChunkAudioPiece[],
): Promise<void> {
  const totalMs = pieces.reduce((sum, piece) => sum + piece.durationMs, 0);
  const paddingMs = Math.max(0, MIN_WHISPER_AUDIO_MS - totalMs);
  const dataBytes = (totalMs + paddingMs) * SAMPLES_PER_MS * BYTES_PER_SAMPLE;
  const out = await open(target, 'wx');
  try {
    await out.write(wavHeader(dataBytes));
    for (const piece of pieces) await copyPiece(out, piece);
    await writeZeros(out, paddingMs * SAMPLES_PER_MS * BYTES_PER_SAMPLE);
  } finally {
    await out.close();
  }
}
