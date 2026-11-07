/**
 * Parser for whisper.cpp CLI JSON output (`-oj` / `--output-json` and
 * `-ojf` / `--output-json-full`).
 *
 * SHAPE SOURCE: written against the `output_json()` writer in whisper.cpp's
 * `examples/cli/cli.cpp` as of the v1.7.x line. The shape has changed before
 * and MUST be re-verified against the output of the exact pinned binary the GM
 * runs (record its version/commit in docs/spikes/S04-whisper.md). The parser is
 * deliberately tolerant: unknown fields are ignored, optional fields may be
 * absent, and anything it cannot interpret is reported in `warnings` rather
 * than silently dropped.
 *
 * Expected shape (abridged):
 * {
 *   "systeminfo": "...",
 *   "model": { "type": "large", "multilingual": true, ... },
 *   "params": { "model": "...", "language": "pt", "translate": false },
 *   "result": { "language": "pt" },
 *   "transcription": [
 *     {
 *       "timestamps": { "from": "00:00:00,000", "to": "00:00:04,320" },
 *       "offsets": { "from": 0, "to": 4320 },          // integer ms
 *       "text": " Olá pessoal",
 *       "tokens": [                                     // -ojf only
 *         { "text": " Ol", "timestamps": {...}, "offsets": {...},
 *           "id": 1234, "p": 0.98, "t_dtw": -1 }
 *       ]
 *     }
 *   ]
 * }
 */

export interface WhisperToken {
  text: string;
  id: number | null;
  /** Token probability as reported by whisper.cpp (`p`), 0..1. */
  p: number | null;
  startMs: number | null;
  endMs: number | null;
  /** DTW timestamp (ms) when `--dtw` was used; null when absent or -1. */
  dtwMs: number | null;
  /** True for control tokens such as `[_BEG_]`, `[_TT_150]`, `<|endoftext|>`. */
  special: boolean;
}

export interface WhisperSegment {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
  /** Empty when the JSON was produced without `-ojf`. */
  tokens: WhisperToken[];
  speakerTurnNext: boolean | null;
}

export interface WhisperTranscript {
  language: string | null;
  modelType: string | null;
  modelPathParam: string | null;
  systemInfo: string | null;
  /** True when at least one segment carried a `tokens` array. */
  hasTokens: boolean;
  segments: WhisperSegment[];
  warnings: string[];
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type JsonObject = { [k: string]: Json };

function isObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Parse an SRT-style `HH:MM:SS,mmm` (also accepts `.` as separator) into
 * integer milliseconds. Returns null when the string is not in that format.
 */
export function parseTimestampToMs(ts: string): number | null {
  const m = /^(\d+):(\d{2}):(\d{2})[,.](\d{1,3})$/.exec(ts.trim());
  if (!m) return null;
  const [, h, mi, s, ms] = m;
  return (
    Number(h) * 3_600_000 +
    Number(mi) * 60_000 +
    Number(s) * 1000 +
    Number((ms ?? "0").padEnd(3, "0"))
  );
}

/** Integer ms from `offsets.{key}` (preferred) or `timestamps.{key}` string. */
function readMs(node: JsonObject, key: "from" | "to"): number | null {
  const offsets = node["offsets"];
  if (isObject(offsets)) {
    const n = num(offsets[key]);
    if (n !== null) return Math.round(n);
  }
  const timestamps = node["timestamps"];
  if (isObject(timestamps)) {
    const s = str(timestamps[key]);
    if (s !== null) return parseTimestampToMs(s);
  }
  return null;
}

const SPECIAL_TOKEN = /^(\[_[A-Z_]+[0-9]*\]|<\|[^|]*\|>)$/;

export function isSpecialTokenText(text: string): boolean {
  return SPECIAL_TOKEN.test(text.trim());
}

function parseToken(raw: unknown): WhisperToken | null {
  if (!isObject(raw)) return null;
  const text = str(raw["text"]) ?? "";
  const dtw = num(raw["t_dtw"]);
  return {
    text,
    id: num(raw["id"]),
    p: num(raw["p"]),
    startMs: readMs(raw, "from"),
    endMs: readMs(raw, "to"),
    // whisper.cpp writes t_dtw in centiseconds (-1 when disabled).
    dtwMs: dtw === null || dtw < 0 ? null : Math.round(dtw * 10),
    special: isSpecialTokenText(text),
  };
}

export function parseWhisperJson(input: string | unknown): WhisperTranscript {
  const root: unknown = typeof input === "string" ? JSON.parse(input) : input;
  if (!isObject(root)) throw new Error("whisper JSON: root is not an object");
  const warnings: string[] = [];

  const transcription = root["transcription"];
  if (!Array.isArray(transcription)) {
    throw new Error("whisper JSON: missing `transcription` array");
  }

  const model = isObject(root["model"]) ? root["model"] : {};
  const params = isObject(root["params"]) ? root["params"] : {};
  const result = isObject(root["result"]) ? root["result"] : {};

  const segments: WhisperSegment[] = [];
  let hasTokens = false;

  transcription.forEach((rawSeg, index) => {
    if (!isObject(rawSeg)) {
      warnings.push(`segment ${index}: not an object, skipped`);
      return;
    }
    const startMs = readMs(rawSeg, "from");
    const endMs = readMs(rawSeg, "to");
    if (startMs === null || endMs === null) {
      warnings.push(`segment ${index}: missing/unparseable offsets, skipped`);
      return;
    }
    if (endMs < startMs) {
      warnings.push(`segment ${index}: end (${endMs}) < start (${startMs})`);
    }
    const tokensRaw = rawSeg["tokens"];
    const tokens: WhisperToken[] = [];
    if (Array.isArray(tokensRaw)) {
      hasTokens = true;
      tokensRaw.forEach((t, ti) => {
        const tok = parseToken(t);
        if (tok) tokens.push(tok);
        else warnings.push(`segment ${index} token ${ti}: not an object`);
      });
    }
    const turn = rawSeg["speaker_turn_next"];
    segments.push({
      index,
      startMs,
      endMs,
      text: (str(rawSeg["text"]) ?? "").trim(),
      tokens,
      speakerTurnNext: typeof turn === "boolean" ? turn : null,
    });
  });

  return {
    language: str(result["language"]) ?? str(params["language"]),
    modelType: str(model["type"]),
    modelPathParam: str(params["model"]),
    systemInfo: str(root["systeminfo"]),
    hasTokens,
    segments,
    warnings,
  };
}

/** Plain transcript text (segments joined by single spaces). */
export function transcriptText(t: WhisperTranscript): string {
  return t.segments
    .map((s) => s.text)
    .filter((s) => s.length > 0)
    .join(" ");
}
