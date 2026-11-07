/**
 * JSONL manifest (THROWAWAY spike). One record per line, appended with a synchronous write followed by
 * fsync, so a record is either fully on disk or (on a forced kill mid-write) a truncated last line that
 * the reader detects and recovery repairs.
 *
 * Write ordering contract (relied on by recovery.ts):
 *   fragment_open  is written BEFORE the `.part` file is created;
 *   fragment_close is written AFTER the `.part` -> final rename succeeded.
 * So "open without close" + `.part` on disk == fragment interrupted by a crash.
 */
import * as fs from "node:fs";

export const MANIFEST_SCHEMA = "s02-manifest/1";
export const OFFSET_ALGORITHM = "s02-arrival-anchor/1";

export type ManifestRecord =
  | {
      type: "session_start";
      schema: string;
      session_id: string;
      t0_hr_ns: string;
      t0_wall_iso: string;
      sample_rate: number;
      channels: number;
      offset_algorithm: string;
      params: Record<string, number | boolean>;
    }
  | {
      type: "fragment_open";
      fragment_id: string;
      user_id: string;
      label: string;
      epoch: number;
      fragment_start_offset_ms: number;
      part_file: string;
      t_ms: number;
    }
  | {
      type: "fragment_close";
      fragment_id: string;
      final_file: string;
      samples: number;
      duration_ms: number;
      end_offset_ms: number;
      end_reason: "silence" | "rotate" | "discontinuity" | "stop";
      gap_fill_count: number;
      gap_fill_ms: number;
      max_early_ms: number;
      packets: number;
      decode_errors: number;
      t_ms: number;
    }
  | {
      type: "fragment_recovered";
      fragment_id: string | null;
      part_file: string;
      recovered_file: string | null;
      samples: number;
      duration_ms: number;
      fragment_start_offset_ms: number | null;
      status: "salvaged" | "empty" | "finalized_unrecorded";
      recovered_at_wall_iso: string;
    }
  | { type: "event"; t_ms: number; event: string; [k: string]: unknown }
  | { type: "session_stop"; t_ms: number; reason: string };

export class ManifestWriter {
  private fd: number;
  constructor(readonly path: string) {
    this.fd = fs.openSync(path, "a");
  }
  append(rec: ManifestRecord): void {
    fs.writeSync(this.fd, JSON.stringify(rec) + "\n");
    fs.fsyncSync(this.fd);
  }
  close(): void {
    fs.closeSync(this.fd);
  }
}

export interface ManifestRead {
  records: ManifestRecord[];
  /** Last line had no trailing newline and did not parse: the signature of a kill mid-append. */
  truncatedTail: string | null;
  /** Byte length of the file up to and including the last complete, parseable line. */
  goodBytes: number;
  /** 1-based line numbers of unparseable lines that were not the tail. */
  corruptLines: number[];
}

export function readManifest(path: string): ManifestRead {
  if (!fs.existsSync(path)) return { records: [], truncatedTail: null, goodBytes: 0, corruptLines: [] };
  const text = fs.readFileSync(path, "utf8");
  const records: ManifestRecord[] = [];
  const corruptLines: number[] = [];
  let truncatedTail: string | null = null;
  let goodBytes = 0;
  let pos = 0;
  let lineNo = 0;
  while (pos < text.length) {
    lineNo += 1;
    const nl = text.indexOf("\n", pos);
    const isTail = nl === -1;
    const line = isTail ? text.slice(pos) : text.slice(pos, nl);
    const next = isTail ? text.length : nl + 1;
    let parsed: ManifestRecord | null = null;
    if (line.trim() !== "") {
      try {
        parsed = JSON.parse(line) as ManifestRecord;
      } catch {
        parsed = null;
      }
    }
    if (parsed && !isTail) {
      records.push(parsed);
      goodBytes = Buffer.byteLength(text.slice(0, next), "utf8");
    } else if (isTail && line.trim() !== "") {
      // A complete JSON object without its newline is still treated as truncated: the writer always
      // terminates records, so the newline is part of the commit.
      truncatedTail = line;
    } else if (!parsed && line.trim() !== "") {
      corruptLines.push(lineNo);
    } else if (!isTail) {
      goodBytes = Buffer.byteLength(text.slice(0, next), "utf8");
    }
    pos = next;
  }
  return { records, truncatedTail, goodBytes, corruptLines };
}
