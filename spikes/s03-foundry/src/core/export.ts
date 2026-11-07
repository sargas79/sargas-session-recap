import { isNamespacedEventId } from "./ids.js";
import type { CapturedEvent } from "./types.js";

export interface ExportResult {
  jsonl: string;
  total: number;
  unique: number;
  duplicates: number;
  invalid: number;
}

function compare(a: CapturedEvent, b: CapturedEvent): number {
  if (a.capturedAt !== b.capturedAt) return a.capturedAt < b.capturedAt ? -1 : 1;
  if (a.recordId !== b.recordId) return a.recordId < b.recordId ? -1 : 1;
  return 0;
}

/**
 * Deduplicate by namespaced eventId, keeping the earliest capture (capturedAt, then recordId).
 * Records whose eventId is not in the spike namespace are dropped and counted as invalid.
 * Output order is deterministic (sorted by capturedAt, recordId).
 */
export function dedupeEvents(events: readonly CapturedEvent[]): {
  unique: CapturedEvent[];
  duplicates: number;
  invalid: number;
} {
  const sorted = [...events].sort(compare);
  const seen = new Set<string>();
  const unique: CapturedEvent[] = [];
  let duplicates = 0;
  let invalid = 0;
  for (const ev of sorted) {
    if (!isNamespacedEventId(ev.eventId)) {
      invalid++;
      continue;
    }
    if (seen.has(ev.eventId)) {
      duplicates++;
      continue;
    }
    seen.add(ev.eventId);
    unique.push(ev);
  }
  return { unique, duplicates, invalid };
}

export function exportJsonl(events: readonly CapturedEvent[]): ExportResult {
  const { unique, duplicates, invalid } = dedupeEvents(events);
  const jsonl = unique.map((e) => JSON.stringify(e)).join("\n") + (unique.length > 0 ? "\n" : "");
  return { jsonl, total: events.length, unique: unique.length, duplicates, invalid };
}

/**
 * Structural check for a parsed JSONL line. JSON.parse happily returns null, numbers, strings or arrays; those (and
 * objects missing the fields dedupe/sort rely on) are not events and must be counted as invalid, not enqueued.
 */
export function isCapturedEventShape(v: unknown): v is CapturedEvent {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.eventId === "string" &&
    typeof e.recordId === "string" &&
    typeof e.sessionId === "string" &&
    typeof e.capturedAt === "string" &&
    Number.isSafeInteger(e.seq)
  );
}

/** Merge several JSONL exports (e.g. from two clients) and dedupe again. Malformed or non-event lines are counted as invalid. */
export function mergeJsonl(...files: string[]): ExportResult {
  const events: CapturedEvent[] = [];
  let malformed = 0;
  for (const file of files) {
    for (const line of file.split(/\r?\n/)) {
      if (line.trim() === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        malformed++;
        continue;
      }
      if (isCapturedEventShape(parsed)) events.push(parsed);
      else malformed++;
    }
  }
  const result = exportJsonl(events);
  return { ...result, total: result.total + malformed, invalid: result.invalid + malformed };
}
