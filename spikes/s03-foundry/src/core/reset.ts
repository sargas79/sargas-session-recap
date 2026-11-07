import type { CaptureController } from "./capture.js";
import type { IssueLedger } from "./durability.js";
import type { BufferedWriter } from "./flush-policy.js";
import type { EventStore } from "./store.js";

export interface ResetDeps {
  capture: CaptureController;
  writer: BufferedWriter;
  store: EventStore;
  ledger: IssueLedger;
}

export interface ResetResult {
  /** Buffered events dropped instead of written (they were issued before the reset and are deliberately discarded). */
  discardedBuffered: number;
}

/**
 * Spike-only reset between measurement runs, coordinated so the next recovery starts from a clean baseline:
 * 1. pause capture (hooks firing meanwhile are dropped and counted in `pausedDrops`, never issued);
 * 2. wait for the in-flight flush and discard what is still buffered, so no pre-reset write can land after the clear;
 * 3. clear the records, then the ledger entries of this world (otherwise deleted records would be reported as losses);
 * 4. restart this page load's sequence at 0 and resume capture.
 * Other open tabs of the same world keep their own counters: close them before resetting (documented in S03-foundry.md).
 */
export async function resetMeasurement(deps: ResetDeps): Promise<ResetResult> {
  const { capture, writer, store, ledger } = deps;
  capture.paused = true;
  try {
    const discardedBuffered = await writer.discardPending();
    await store.clear();
    ledger.reset();
    capture.resetSequence();
    return { discardedBuffered };
  } finally {
    capture.paused = false;
  }
}
