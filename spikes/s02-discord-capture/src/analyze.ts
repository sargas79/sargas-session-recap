/**
 * Reference-timing analysis (THROWAWAY spike). For every `/spike mark` beep, finds the 1 kHz beep onset
 * in each speaker's captured fragments (picked up acoustically by participants on speakers, not
 * headphones) and reports its session position, using the documented offset algorithm:
 *     onset_session_ms = fragment_start_offset_ms + onset_sample_index / 48
 * The cross-speaker spread of onsets for the same beep is the timing error between tracks (target
 * <= ~100 ms). The delta to `beep_play_t_ms` includes the bot->client->speaker->mic->bot path and should
 * be roughly constant over the session; its drift over time is the second number to report.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { readManifest } from "./manifest.js";
import { SAMPLE_RATE } from "./offsets.js";
import { WAV_HEADER_BYTES, parseWavHeader } from "./wav.js";

export function readWavMono(file: string): Int16Array {
  const buf = fs.readFileSync(file);
  const h = parseWavHeader(buf);
  if (!h || h.channels !== 1) throw new Error(`${file}: expected mono 16-bit WAV`);
  const bytes = Math.min(h.declaredDataBytes, buf.length - WAV_HEADER_BYTES) & ~1;
  return new Int16Array(buf.buffer.slice(buf.byteOffset + WAV_HEADER_BYTES, buf.byteOffset + WAV_HEADER_BYTES + bytes));
}

/** Fraction of block energy at `freq` (≈1 for a pure tone, ≈0 for silence/broadband). */
export function toneRatio(x: Int16Array, start: number, n: number, freq: number): { ratio: number; rms: number } {
  const k = (2 * Math.PI * freq) / SAMPLE_RATE;
  const coeff = 2 * Math.cos(k);
  let s1 = 0;
  let s2 = 0;
  let energy = 0;
  for (let i = 0; i < n; i++) {
    const v = x[start + i]! / 32768;
    energy += v * v;
    const s0 = v + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
  const rms = Math.sqrt(energy / n);
  return { ratio: energy > 0 ? power / ((n / 2) * energy) : 0, rms };
}

/** Index of the first sample of the first 10 ms block that looks like the beep, or null. */
export function findToneOnset(x: Int16Array, freq = 1000, opts: { minRatio?: number; minRms?: number; fromSample?: number } = {}): number | null {
  const block = SAMPLE_RATE / 100;
  const minRatio = opts.minRatio ?? 0.5;
  const minRms = opts.minRms ?? 0.01;
  for (let s = opts.fromSample ?? 0; s + block <= x.length; s += block) {
    const { ratio, rms } = toneRatio(x, s, block, freq);
    if (ratio >= minRatio && rms >= minRms) return s;
  }
  return null;
}

export interface MarkResult {
  label: string;
  beep_play_t_ms: number;
  onsets: { speaker: string; fragment_id: string; onset_ms: number; delta_ms: number }[];
  spread_ms: number | null;
}

export function analyzeSession(dir: string, windowMs = 3000): MarkResult[] {
  const { records } = readManifest(path.join(dir, "manifest.jsonl"));
  const frags: { id: string; label: string; start: number; end: number; file: string }[] = [];
  const opens = new Map<string, { label: string; start: number }>();
  for (const r of records) {
    if (r.type === "fragment_open") opens.set(r.fragment_id, { label: r.label, start: r.fragment_start_offset_ms });
    if (r.type === "fragment_close") {
      const o = opens.get(r.fragment_id);
      if (o) frags.push({ id: r.fragment_id, label: o.label, start: o.start, end: o.start + r.duration_ms, file: r.final_file });
    }
    // Recovered audio counts too: `salvaged` (.part patched) and `finalized_unrecorded` (kill between the
    // rename and fragment_close: a valid final WAV with no close record). Only empty/missing are skipped.
    if (r.type === "fragment_recovered" && r.recovered_file && r.fragment_id && (r.status === "salvaged" || r.status === "finalized_unrecorded")) {
      const o = opens.get(r.fragment_id);
      if (o) frags.push({ id: r.fragment_id, label: o.label, start: o.start, end: o.start + r.duration_ms, file: r.recovered_file });
    }
  }
  const results: MarkResult[] = [];
  for (const r of records) {
    if (r.type !== "event" || r.event !== "mark_beep_playing") continue;
    const t = r.t_ms;
    const res: MarkResult = { label: String(r.label ?? ""), beep_play_t_ms: t, onsets: [], spread_ms: null };
    const best = new Map<string, MarkResult["onsets"][number]>();
    for (const f of frags) {
      if (f.end < t || f.start > t + windowMs) continue;
      const x = readWavMono(path.join(dir, f.file));
      const from = Math.max(0, Math.round(((t - f.start) * SAMPLE_RATE) / 1000));
      const idx = findToneOnset(x, 1000, { fromSample: from - (from % (SAMPLE_RATE / 100)) });
      if (idx === null) continue;
      const onset = f.start + Math.round((idx * 1000) / SAMPLE_RATE);
      if (onset > t + windowMs) continue;
      const prev = best.get(f.label);
      if (!prev || onset < prev.onset_ms) best.set(f.label, { speaker: f.label, fragment_id: f.id, onset_ms: onset, delta_ms: onset - t });
    }
    res.onsets = [...best.values()].sort((a, b) => a.speaker.localeCompare(b.speaker));
    if (res.onsets.length >= 2) {
      const os = res.onsets.map((o) => o.onset_ms);
      res.spread_ms = Math.max(...os) - Math.min(...os);
    }
    results.push(res);
  }
  return results;
}
