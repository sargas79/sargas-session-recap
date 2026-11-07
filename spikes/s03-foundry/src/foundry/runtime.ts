import type { CaptureController } from "../core/capture.js";
import type { IssueLedger, RecoveryReport } from "../core/durability.js";
import type { BufferedWriter } from "../core/flush-policy.js";
import type { EventStore } from "../core/store.js";
import type { ProbeState } from "./probe.js";

export interface ImportOutcome {
  at: string;
  ok: boolean;
  journalId?: string;
  pageCount?: number;
  errors: string[];
  /** Ownership violations found by re-reading the created documents (empty = GM-only as built). */
  violations: string[];
}

export interface SpikeRuntime {
  ready: boolean;
  initError: string | null;
  sessionId: string;
  store: EventStore | null;
  writer: BufferedWriter | null;
  ledger: IssueLedger | null;
  capture: CaptureController | null;
  recovery: RecoveryReport | null;
  probe: ProbeState | null;
  marks: number;
  lastImport: ImportOutcome | null;
  lastExport: { at: string; unique: number; duplicates: number; invalid: number } | null;
}
