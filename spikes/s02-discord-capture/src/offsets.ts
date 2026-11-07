/**
 * `fragment_start_offset_ms` algorithm — "s02-arrival-anchor/1" (THROWAWAY spike, documented in
 * docs/spikes/S02-discord-capture.md, section "Offset algorithm").
 *
 * Why arrival time: @discordjs/voice 0.19 hands the receiver only the decrypted Opus payload; the RTP
 * timestamp/sequence are not exposed on AudioReceiveStream. The only timing signal we have is when the
 * packet reached our process, read from the monotonic session clock (clock.ts).
 *
 * Rules:
 *  1. Session clock. t0 = process.hrtime.bigint() at `/spike start`. It is never reset, including across
 *     voice reconnects. All offsets are integer ms since t0.
 *  2. Fragment anchor. A fragment's first sample is placed at the arrival time of its first Opus packet:
 *        fragment_start_offset_ms = round((first_packet_arrival_ns - t0_ns) / 1e6) - latency_compensation_ms
 *     clamped at >= 0. `latency_compensation_ms` defaults to 0 and is a constant measured in the live run
 *     with `/spike mark` references (it cancels a constant capture->arrival delay; it cannot fix jitter).
 *  3. Inside a fragment, samples are contiguous (48 kHz, mono after downmix). Discord stops sending
 *     packets during silence, so a gap inside a fragment would otherwise collapse and shift every later
 *     sample earlier. For each packet we compute
 *        drift_ms = (arrival_ns - (first_packet_arrival_ns + samples_written / 48 kHz)) / 1e6
 *     If drift_ms > gap_fill_threshold_ms, we insert floor(drift_ms / frame_ms) frames of zero samples
 *     before the packet (a "gap fill"), re-aligning the sample timeline with the arrival timeline.
 *     Negative drift (bursts after jitter) is never corrected by dropping audio; its max is recorded
 *     (`max_early_ms`) as a diagnostic.
 *  4. Long silences end the fragment. When no packet arrives for `silence_close_ms` the receive stream
 *     ends and the fragment is finalized. The next utterance opens a new fragment re-anchored by rule 2,
 *     so silence between fragments costs no disk space and drift never accumulates across fragments.
 *  5. Rotation. A fragment longer than `max_fragment_ms` is closed (end_reason "rotate") and the next
 *     packet opens a new fragment re-anchored by rule 2. This bounds what a single `.part` can lose.
 *  6. Reconnect discontinuity. When the voice connection leaves Ready, every open fragment is closed
 *     (end_reason "discontinuity"), the epoch counter increments and a discontinuity [start_ms, end_ms]
 *     is logged. Audio during the gap is lost (Discord does not replay it). Fragments after the
 *     reconnect use the same t0 (rule 1), so their offsets stay on the session timeline; they carry the
 *     new epoch so consumers know a discontinuity lies between them and the previous ones.
 *  7. Process restart (crash) starts a new session with a new t0. Cross-session alignment can only use
 *     the wall-clock anchors and is flagged as lower precision.
 */
import { nsToMs } from "./clock.js";

export const SAMPLE_RATE = 48_000;
export const FRAME_MS = 20;
export const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000; // 960

export interface TimelineParams {
  gapFillThresholdMs: number;
  latencyCompensationMs: number;
}

export function fragmentStartOffsetMs(
  t0Ns: bigint,
  firstPacketArrivalNs: bigint,
  latencyCompensationMs: number,
): number {
  return Math.max(0, nsToMs(firstPacketArrivalNs - t0Ns) - latencyCompensationMs);
}

/** Converts a sample count at 48 kHz to integer ms (floor). */
export function samplesToMs(samples: number): number {
  return Math.floor((samples * 1000) / SAMPLE_RATE);
}

export class FragmentTimeline {
  readonly startOffsetMs: number;
  private readonly firstArrivalNs: bigint;
  private samplesWritten = 0;
  private gapFillSamples = 0;
  private gapFillCount = 0;
  private maxEarlyMs = 0;

  constructor(
    t0Ns: bigint,
    firstPacketArrivalNs: bigint,
    private readonly params: TimelineParams,
  ) {
    this.firstArrivalNs = firstPacketArrivalNs;
    this.startOffsetMs = fragmentStartOffsetMs(t0Ns, firstPacketArrivalNs, params.latencyCompensationMs);
  }

  /**
   * Call before writing a packet's decoded samples. Returns how many zero samples to write first
   * (rule 3). The caller must then call `commit(decodedSamples)`.
   */
  padBefore(arrivalNs: bigint): number {
    // No shortcut for samplesWritten === 0: the fragment is anchored at the first packet's arrival even
    // if that packet failed to decode, so a late first valid frame must be gap-filled too.
    const expectedNs = this.firstArrivalNs + (BigInt(this.samplesWritten) * 1_000_000_000n) / BigInt(SAMPLE_RATE);
    const driftMs = Number(arrivalNs - expectedNs) / 1e6;
    if (driftMs > this.params.gapFillThresholdMs) {
      const frames = Math.floor(driftMs / FRAME_MS);
      const pad = frames * FRAME_SAMPLES;
      this.gapFillSamples += pad;
      this.gapFillCount += 1;
      this.samplesWritten += pad;
      return pad;
    }
    if (-driftMs > this.maxEarlyMs) this.maxEarlyMs = -driftMs;
    return 0;
  }

  commit(samples: number): void {
    this.samplesWritten += samples;
  }

  get totalSamples(): number {
    return this.samplesWritten;
  }

  get durationMs(): number {
    return samplesToMs(this.samplesWritten);
  }

  get endOffsetMs(): number {
    return this.startOffsetMs + this.durationMs;
  }

  stats(): { gap_fill_count: number; gap_fill_ms: number; max_early_ms: number } {
    return {
      gap_fill_count: this.gapFillCount,
      gap_fill_ms: samplesToMs(this.gapFillSamples),
      max_early_ms: Math.round(this.maxEarlyMs),
    };
  }
}
