/**
 * Startup recovery after a forced kill (THROWAWAY spike).
 *
 * Detects, per session directory:
 *   - a truncated last manifest line (kill mid-append): the tail is preserved in
 *     `manifest.jsonl.corrupt-tail` and the manifest is truncated back to its last complete record;
 *   - `*.wav.part` files (fragment open when the process died): the header is patched from the file
 *     size, any partial trailing sample is cut, and the file is renamed to `*.recovered.wav`;
 *     a zero-sample part becomes `*.wav.empty`;
 *   - fragments renamed to final but whose `fragment_close` never reached the manifest;
 *   - fragments whose `.part` an earlier, interrupted recovery already renamed to `*.recovered.wav` /
 *     `*.wav.empty` without recording it;
 *   - fragments with an open record and no file at all (reported as missing).
 * Each outcome, including `missing`, is appended as a terminal `fragment_recovered` manifest record right
 * after the action, so recovery is idempotent even if it is itself interrupted part-way.
 *
 * Loss bound: if the kill time is known on the same monotonic clock (kill-test.ts records it), each
 * interrupted fragment reports `loss_ms_if_speaking_at_kill = kill_offset_ms - salvaged_end_offset_ms`.
 * That is the audio lost for a speaker who was talking continuously through the kill, which is how the
 * live forced-kill case is run.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { nsToMs } from "./clock.js";
import { ManifestWriter, readManifest, type ManifestRecord } from "./manifest.js";
import { PART_SUFFIX } from "./fragment-writer.js";
import { samplesToMs } from "./offsets.js";
import { WAV_HEADER_BYTES, parseWavHeader, wavHeader } from "./wav.js";

export interface InterruptedFragment {
  fragment_id: string | null;
  part_file: string;
  status: "salvaged" | "empty" | "finalized_unrecorded" | "missing";
  recovered_file: string | null;
  samples: number;
  duration_ms: number;
  fragment_start_offset_ms: number | null;
  salvaged_end_offset_ms: number | null;
  loss_ms_if_speaking_at_kill: number | null;
}

export interface RecoveryReport {
  session_dir: string;
  manifest_truncated_tail: boolean;
  manifest_corrupt_lines: number[];
  abnormal_end: boolean;
  last_record_t_ms: number | null;
  kill_offset_ms: number | null;
  interrupted: InterruptedFragment[];
  max_loss_ms: number | null;
  actions: string[];
}

type Open = Extract<ManifestRecord, { type: "fragment_open" }>;

function salvagePart(dir: string, partName: string): { samples: number; recovered: string | null; status: "salvaged" | "empty" } {
  const partPath = path.join(dir, partName);
  const size = fs.statSync(partPath).size;
  const fd = fs.openSync(partPath, "r+");
  try {
    const head = Buffer.alloc(WAV_HEADER_BYTES);
    const got = size >= WAV_HEADER_BYTES ? fs.readSync(fd, head, 0, WAV_HEADER_BYTES, 0) : 0;
    const parsed = got === WAV_HEADER_BYTES ? parseWavHeader(head) : null;
    const channels = parsed?.channels ?? 1;
    const sampleRate = parsed?.sampleRate ?? 48_000;
    const blockAlign = channels * 2;
    const dataBytes = size > WAV_HEADER_BYTES ? Math.floor((size - WAV_HEADER_BYTES) / blockAlign) * blockAlign : 0;
    if (dataBytes === 0) {
      fs.closeSync(fd);
      const empty = recoveredNames(partName).empty;
      fs.renameSync(partPath, path.join(dir, empty));
      return { samples: 0, recovered: empty, status: "empty" };
    }
    fs.writeSync(fd, wavHeader(dataBytes, { sampleRate, channels }), 0, WAV_HEADER_BYTES, 0);
    fs.ftruncateSync(fd, WAV_HEADER_BYTES + dataBytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    const recovered = recoveredNames(partName).recovered;
    fs.renameSync(partPath, path.join(dir, recovered));
    return { samples: dataBytes / blockAlign, recovered, status: "salvaged" };
  } catch (e) {
    try {
      fs.closeSync(fd);
    } catch {
      /* already closed */
    }
    throw e;
  }
}

/** Names salvagePart gives a part: `x.wav.part` -> `x.recovered.wav` / `x.wav.empty`. */
function recoveredNames(partName: string): { recovered: string; empty: string } {
  return {
    recovered: partName.slice(0, -".wav.part".length) + ".recovered.wav",
    empty: partName.slice(0, -PART_SUFFIX.length) + ".empty",
  };
}

function wavSamples(file: string): number {
  const size = fs.statSync(file).size;
  const head = Buffer.alloc(WAV_HEADER_BYTES);
  const fd = fs.openSync(file, "r");
  fs.readSync(fd, head, 0, WAV_HEADER_BYTES, 0);
  fs.closeSync(fd);
  const ch = parseWavHeader(head)?.channels ?? 1;
  return Math.floor((size - WAV_HEADER_BYTES) / (ch * 2));
}

export function recoverSession(dir: string, opts: { killHrNs?: bigint; wallNow?: () => number } = {}): RecoveryReport {
  const manifestPath = path.join(dir, "manifest.jsonl");
  const wallNow = opts.wallNow ?? Date.now;
  const actions: string[] = [];
  const read = readManifest(manifestPath);
  if (read.truncatedTail !== null) {
    fs.appendFileSync(path.join(dir, "manifest.jsonl.corrupt-tail"), read.truncatedTail + "\n");
    fs.truncateSync(manifestPath, read.goodBytes);
    actions.push(`truncated manifest to ${read.goodBytes} bytes; tail saved to manifest.jsonl.corrupt-tail`);
  }
  const recs = read.records;
  const start = recs.find((r) => r.type === "session_start");
  const opens = new Map<string, Open>();
  const closed = new Set<string>();
  const recoveredParts = new Set<string>();
  let lastT: number | null = null;
  let stopped = false;
  for (const r of recs) {
    if ("t_ms" in r && typeof r.t_ms === "number") lastT = Math.max(lastT ?? 0, r.t_ms);
    if (r.type === "fragment_open") opens.set(r.part_file, r);
    else if (r.type === "fragment_close") closed.add(r.fragment_id);
    else if (r.type === "fragment_recovered") recoveredParts.add(r.part_file);
    else if (r.type === "session_stop") stopped = true;
  }
  const killOffset = opts.killHrNs !== undefined && start?.type === "session_start" ? nsToMs(opts.killHrNs - BigInt(start.t0_hr_ns)) : null;

  const interrupted: InterruptedFragment[] = [];
  const out: { writer: ManifestWriter | null } = { writer: null };
  const record = (r: ManifestRecord) => {
    out.writer ??= new ManifestWriter(manifestPath);
    out.writer.append(r);
  };
  const files = new Set(fs.readdirSync(dir));
  const handled = new Set<string>();

  const push = (open: Open | undefined, partName: string, status: InterruptedFragment["status"], recovered: string | null, samples: number) => {
    const startMs = open?.fragment_start_offset_ms ?? null;
    const dur = samplesToMs(samples);
    const end = startMs === null ? null : startMs + dur;
    interrupted.push({
      fragment_id: open?.fragment_id ?? null,
      part_file: partName,
      status,
      recovered_file: recovered,
      samples,
      duration_ms: dur,
      fragment_start_offset_ms: startMs,
      salvaged_end_offset_ms: end,
      loss_ms_if_speaking_at_kill: killOffset !== null && end !== null ? Math.max(0, killOffset - end) : null,
    });
    // Recorded immediately (not batched), so an interruption later in this run cannot orphan this action.
    record({
      type: "fragment_recovered",
      fragment_id: open?.fragment_id ?? null,
      part_file: partName,
      recovered_file: recovered,
      samples,
      duration_ms: dur,
      fragment_start_offset_ms: startMs,
      status,
      recovered_at_wall_iso: new Date(wallNow()).toISOString(),
    });
  };

  const abnormal = !stopped;
  try {
    // 1) .part files on disk.
    for (const f of [...files].sort()) {
      if (!f.endsWith(".wav" + PART_SUFFIX) || recoveredParts.has(f)) continue;
      const open = opens.get(f);
      const res = salvagePart(dir, f);
      actions.push(`${f} -> ${res.recovered} (${res.status}, ${res.samples} samples)`);
      push(open, f, res.status, res.recovered, res.samples);
      handled.add(f);
    }
    // 2) open records whose .part is gone without a close record.
    for (const [part, open] of opens) {
      if (closed.has(open.fragment_id) || recoveredParts.has(part) || handled.has(part)) continue;
      const finalName = part.slice(0, -PART_SUFFIX.length);
      const prior = recoveredNames(part);
      if (files.has(prior.recovered)) {
        // An earlier recovery salvaged and renamed this part but was interrupted before recording it.
        const samples = wavSamples(path.join(dir, prior.recovered));
        actions.push(`${prior.recovered} already salvaged by an interrupted recovery; recording it`);
        push(open, part, "salvaged", prior.recovered, samples);
      } else if (files.has(prior.empty)) {
        actions.push(`${prior.empty} already marked empty by an interrupted recovery; recording it`);
        push(open, part, "empty", prior.empty, 0);
      } else if (files.has(finalName)) {
        const samples = wavSamples(path.join(dir, finalName));
        actions.push(`${finalName} finalized but close record missing`);
        push(open, part, "finalized_unrecorded", finalName, samples);
      } else {
        actions.push(`${open.fragment_id}: open record but no file on disk`);
        push(open, part, "missing", null, 0);
      }
    }

    if (abnormal) record({ type: "session_stop", t_ms: lastT ?? 0, reason: "recovered_after_abnormal_end" });
  } finally {
    out.writer?.close();
  }
  const losses = interrupted.map((i) => i.loss_ms_if_speaking_at_kill).filter((x): x is number => x !== null);
  const report: RecoveryReport = {
    session_dir: dir,
    manifest_truncated_tail: read.truncatedTail !== null,
    manifest_corrupt_lines: read.corruptLines,
    abnormal_end: abnormal,
    last_record_t_ms: lastT,
    kill_offset_ms: killOffset,
    interrupted,
    max_loss_ms: losses.length ? Math.max(...losses) : null,
    actions,
  };
  if (actions.length > 0 || abnormal) {
    const stamp = new Date(wallNow()).toISOString().replace(/[-:.]/g, "");
    fs.writeFileSync(path.join(dir, `recovery-${stamp}.json`), JSON.stringify(report, null, 2) + "\n");
  }
  return report;
}

/** Runs recovery on every session directory under the output root. Called on harness startup. */
export function recoverAll(outputRoot: string, opts: Parameters<typeof recoverSession>[1] = {}): RecoveryReport[] {
  if (!fs.existsSync(outputRoot)) return [];
  const out: RecoveryReport[] = [];
  for (const d of fs.readdirSync(outputRoot, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const dir = path.join(outputRoot, d.name);
    if (fs.existsSync(path.join(dir, "manifest.jsonl"))) out.push(recoverSession(dir, opts));
  }
  return out;
}
