/**
 * CaptureSession (THROWAWAY spike): Discord-independent core of the harness. bot.ts feeds it Opus
 * packets with their monotonic arrival time; tests feed it synthetic packets with a FakeClock.
 *
 * Opt-in is enforced twice: bot.ts never subscribes to a non-allowlisted user, and onPacket drops any
 * packet from a non-allowlisted user before it is decoded or written. Non-opted-in user IDs are never
 * written anywhere.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Clock } from "./clock.js";
import { nsToMs } from "./clock.js";
import type { Allowlist } from "./config.js";
import { FragmentWriter } from "./fragment-writer.js";
import { MANIFEST_SCHEMA, ManifestWriter, OFFSET_ALGORITHM } from "./manifest.js";
import { FragmentTimeline, SAMPLE_RATE } from "./offsets.js";

export interface Decoder {
  /** Decodes one Opus packet to mono 48 kHz signed 16-bit samples. */
  decode(opus: Buffer): Int16Array;
}

export interface SessionParams {
  silence_close_ms: number;
  gap_fill_threshold_ms: number;
  latency_compensation_ms: number;
  max_fragment_ms: number;
  flush_interval_ms: number;
}

interface OpenFragment {
  id: string;
  writer: FragmentWriter;
  timeline: FragmentTimeline;
  packets: number;
  decodeErrors: number;
}

interface Speaker {
  userId: string;
  label: string;
  decoder: Decoder;
  fragment: OpenFragment | null;
}

const SESSION_PARAM_KEYS = [
  "silence_close_ms",
  "gap_fill_threshold_ms",
  "latency_compensation_ms",
  "max_fragment_ms",
  "flush_interval_ms",
] as const satisfies readonly (keyof SessionParams)[];

export function pickSessionParams(p: SessionParams): Record<(typeof SESSION_PARAM_KEYS)[number], number> {
  const out = {} as Record<(typeof SESSION_PARAM_KEYS)[number], number>;
  for (const k of SESSION_PARAM_KEYS) out[k] = p[k];
  return out;
}

export type EndReason = "silence" | "rotate" | "discontinuity" | "stop";

export class CaptureSession {
  readonly t0Ns: bigint;
  readonly dir: string;
  private readonly manifest: ManifestWriter;
  private readonly speakers = new Map<string, Speaker>();
  private seq = 0;
  private epoch = 0;
  private discontinuityStartMs: number | null = null;
  private ignoredPackets = 0;
  private stopped = false;

  constructor(
    private readonly opts: {
      outputRoot: string;
      sessionId: string;
      clock: Clock;
      allowlist: Allowlist;
      params: SessionParams;
      decoderFactory: () => Decoder;
    },
  ) {
    this.dir = path.join(opts.outputRoot, opts.sessionId);
    fs.mkdirSync(this.dir, { recursive: true });
    this.t0Ns = opts.clock.nowNs();
    this.manifest = new ManifestWriter(path.join(this.dir, "manifest.jsonl"));
    this.manifest.append({
      type: "session_start",
      schema: MANIFEST_SCHEMA,
      session_id: opts.sessionId,
      t0_hr_ns: this.t0Ns.toString(),
      t0_wall_iso: new Date(opts.clock.wallMs()).toISOString(),
      sample_rate: SAMPLE_RATE,
      channels: 1,
      offset_algorithm: OFFSET_ALGORITHM,
      // Copy only the known numeric session parameters. Never spread a caller object here: a full
      // HarnessConfig would leak gm_user_id / guild ids / output path into the manifest.
      params: pickSessionParams(opts.params),
    });
  }

  nowMs(): number {
    return nsToMs(this.opts.clock.nowNs() - this.t0Ns);
  }

  get currentEpoch(): number {
    return this.epoch;
  }

  get ignoredPacketCount(): number {
    return this.ignoredPackets;
  }

  openFragmentCount(): number {
    let n = 0;
    for (const s of this.speakers.values()) if (s.fragment) n++;
    return n;
  }

  /** Feeds one Opus packet. Returns "ignored" for non-opted-in users (nothing decoded or stored). */
  onPacket(userId: string, opus: Buffer, arrivalNs: bigint = this.opts.clock.nowNs()): "recorded" | "ignored" {
    if (this.stopped) return "ignored";
    if (!this.opts.allowlist.isOptedIn(userId)) {
      if (this.ignoredPackets === 0) this.event("non_optin_audio_ignored", {});
      this.ignoredPackets++;
      return "ignored";
    }
    const sp = this.speaker(userId);
    if (sp.fragment && sp.fragment.timeline.durationMs >= this.opts.params.max_fragment_ms) {
      this.closeFragment(sp, "rotate");
    }
    if (!sp.fragment) sp.fragment = this.openFragment(sp, arrivalNs);
    const frag = sp.fragment;
    frag.packets++;
    let pcm: Int16Array;
    try {
      pcm = sp.decoder.decode(opus);
    } catch {
      frag.decodeErrors++;
      return "recorded";
    }
    const pad = frag.timeline.padBefore(arrivalNs);
    frag.writer.writeSilence(pad);
    frag.writer.write(pcm);
    frag.timeline.commit(pcm.length);
    return "recorded";
  }

  /** The receive stream for this user ended (silence_close_ms without packets). */
  onStreamEnd(userId: string): void {
    const sp = this.speakers.get(userId);
    if (sp?.fragment) this.closeFragment(sp, "silence");
  }

  /** Voice connection left Ready: close everything, bump epoch (offset algorithm rule 6). */
  beginDiscontinuity(reason: string): void {
    if (this.stopped || this.discontinuityStartMs !== null) return;
    for (const sp of this.speakers.values()) {
      if (sp.fragment) this.closeFragment(sp, "discontinuity");
      // Opus decoder state is per stream; start fresh after a reconnect.
      sp.decoder = this.opts.decoderFactory();
    }
    this.discontinuityStartMs = this.nowMs();
    this.epoch++;
    this.event("discontinuity_start", { reason, new_epoch: this.epoch });
  }

  endDiscontinuity(): void {
    if (this.stopped || this.discontinuityStartMs === null) return;
    const now = this.nowMs();
    this.event("discontinuity_end", { epoch: this.epoch, start_ms: this.discontinuityStartMs, gap_ms: now - this.discontinuityStartMs });
    this.discontinuityStartMs = null;
  }

  /** No-op after stop(): late Discord callbacks must not write to the closed manifest. */
  event(name: string, fields: Record<string, unknown>): void {
    if (this.stopped) return;
    this.manifest.append({ type: "event", t_ms: this.nowMs(), event: name, epoch: this.epoch, ...fields });
  }

  mark(label: string, extra: Record<string, unknown> = {}): number {
    const t = this.nowMs();
    if (this.stopped) return t;
    this.manifest.append({ type: "event", t_ms: t, event: "mark", label, epoch: this.epoch, ...extra });
    return t;
  }

  stop(reason = "stop_command"): void {
    if (this.stopped) return;
    for (const sp of this.speakers.values()) if (sp.fragment) this.closeFragment(sp, "stop");
    this.manifest.append({ type: "session_stop", t_ms: this.nowMs(), reason });
    this.manifest.close();
    this.stopped = true;
  }

  private speaker(userId: string): Speaker {
    let sp = this.speakers.get(userId);
    if (!sp) {
      sp = { userId, label: this.opts.allowlist.labelOf(userId)!, decoder: this.opts.decoderFactory(), fragment: null };
      this.speakers.set(userId, sp);
    }
    return sp;
  }

  private openFragment(sp: Speaker, arrivalNs: bigint): OpenFragment {
    this.seq++;
    const id = `${sp.label}-${String(this.seq).padStart(6, "0")}`;
    const timeline = new FragmentTimeline(this.t0Ns, arrivalNs, {
      gapFillThresholdMs: this.opts.params.gap_fill_threshold_ms,
      latencyCompensationMs: this.opts.params.latency_compensation_ms,
    });
    const base = `${sp.label}_${String(this.seq).padStart(6, "0")}`;
    // Manifest record first, then the .part file (see manifest.ts write-ordering contract).
    this.manifest.append({
      type: "fragment_open",
      fragment_id: id,
      user_id: sp.userId,
      label: sp.label,
      epoch: this.epoch,
      fragment_start_offset_ms: timeline.startOffsetMs,
      part_file: `${base}.wav.part`,
      t_ms: this.nowMs(),
    });
    const writer = new FragmentWriter(
      this.dir,
      base,
      { sampleRate: SAMPLE_RATE, channels: 1 },
      this.opts.params.flush_interval_ms,
      () => this.nowMs(),
    );
    return { id, writer, timeline, packets: 0, decodeErrors: 0 };
  }

  private closeFragment(sp: Speaker, reason: EndReason): void {
    const f = sp.fragment;
    if (!f) return;
    sp.fragment = null;
    const finalPath = f.writer.finalize();
    // Manifest close only after the rename succeeded.
    this.manifest.append({
      type: "fragment_close",
      fragment_id: f.id,
      final_file: path.basename(finalPath),
      samples: f.timeline.totalSamples,
      duration_ms: f.timeline.durationMs,
      end_offset_ms: f.timeline.endOffsetMs,
      end_reason: reason,
      ...f.timeline.stats(),
      packets: f.packets,
      decode_errors: f.decodeErrors,
      t_ms: this.nowMs(),
    });
  }
}

/** Windows-safe session id from a wall-clock time, e.g. s02-20261107T155900Z. */
export function sessionIdFor(wallMs: number): string {
  return "s02-" + new Date(wallMs).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}
