/**
 * Reads whisper.cpp `-ojf` output (shape recorded in `docs/spikes/S04-whisper.md` section 5.1,
 * verified against v1.9.5). Unknown fields are ignored, including `systeminfo`, the one field S04
 * saw change between identical runs; nothing derived from this file may hash it.
 *
 * Whisper reports floats and strings; this is where they become integer milliseconds (ADR-003).
 */
export interface WhisperToken {
  readonly text: string;
  readonly probability: number | undefined;
  /** Control tokens such as `[_BEG_]` or `<|endoftext|>`, not speech. */
  readonly special: boolean;
}

export interface WhisperSegment {
  /** Undefined when the file has no usable time for this edge. */
  readonly fromMs: number | undefined;
  readonly toMs: number | undefined;
  readonly text: string;
  readonly tokens: readonly WhisperToken[];
}

export interface WhisperOutput {
  readonly segments: readonly WhisperSegment[];
}

/** The file is not whisper JSON. Messages never quote the file: it holds transcript text. */
export class WhisperOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WhisperOutputError';
  }
}

const SPECIAL_TOKEN = /^(?:\[_[A-Z_]+\d*\]|<\|[^|]*\|>)$/;
const TIMESTAMP = /^(\d+):(\d{2}):(\d{2})[,.](\d{1,3})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function timestampMs(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = TIMESTAMP.exec(value.trim());
  if (match === null) return undefined;
  const [, hours, minutes, seconds, millis] = match;
  return (
    Number(hours) * 3_600_000 +
    Number(minutes) * 60_000 +
    Number(seconds) * 1000 +
    Number((millis ?? '0').padEnd(3, '0'))
  );
}

function readMs(segment: Record<string, unknown>, edge: 'from' | 'to'): number | undefined {
  const offsets = segment['offsets'];
  if (isRecord(offsets)) {
    const value = offsets[edge];
    if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  }
  const timestamps = segment['timestamps'];
  return isRecord(timestamps) ? timestampMs(timestamps[edge]) : undefined;
}

function readToken(value: unknown): WhisperToken | undefined {
  if (!isRecord(value)) return undefined;
  const text = typeof value['text'] === 'string' ? value['text'] : '';
  const p = value['p'];
  return {
    text,
    probability: typeof p === 'number' && Number.isFinite(p) ? p : undefined,
    special: SPECIAL_TOKEN.test(text.trim()),
  };
}

function readSegment(value: unknown, index: number): WhisperSegment {
  if (!isRecord(value)) {
    throw new WhisperOutputError(`whisper JSON: segment ${String(index)} is not an object`);
  }
  const tokens = Array.isArray(value['tokens']) ? value['tokens'] : [];
  return {
    fromMs: readMs(value, 'from'),
    toMs: readMs(value, 'to'),
    text: typeof value['text'] === 'string' ? value['text'] : '',
    tokens: tokens.flatMap((token) => readToken(token) ?? []),
  };
}

export function parseWhisperJson(text: string): WhisperOutput {
  let root: unknown;
  try {
    // whisper.cpp escapes quotes and backslashes only, so a control character in a token would
    // be invalid JSON. Between tokens a blank is equivalent; the raw file keeps the original.
    // eslint-disable-next-line no-control-regex
    root = JSON.parse(text.replace(/[\u0000-\u001f]/g, ' '));
  } catch {
    throw new WhisperOutputError('whisper JSON: the file is not valid JSON');
  }
  if (!isRecord(root) || !Array.isArray(root['transcription'])) {
    throw new WhisperOutputError('whisper JSON: no `transcription` array');
  }
  return { segments: root['transcription'].map(readSegment) };
}
