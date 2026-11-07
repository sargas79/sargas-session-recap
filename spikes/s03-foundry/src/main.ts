/**
 * S03 THROWAWAY spike entry point (Foundry esmodule). Not production code: T16 (#21) owns the real module.
 * All Foundry APIs used here (Hooks.once("init"/"ready"), game.settings.register/registerMenu, ApplicationV2,
 * JournalEntry.create) are candidates to verify on the host's v14 + PF2e build.
 */
import { CaptureController } from "./core/capture.js";
import { IssueLedger, recover } from "./core/durability.js";
import { BufferedWriter, DEFAULT_FLUSH_POLICY } from "./core/flush-policy.js";
import { MODULE_ID, newSessionId } from "./core/ids.js";
import { resetMeasurement } from "./core/reset.js";
import { openEventStore, worldDbName } from "./core/store.js";
import { exportEvents, SETTING_WRITER, thisClientWrites, worldNamespace } from "./foundry/actions.js";
import { createPanelClass } from "./foundry/panel.js";
import { registerProbes } from "./foundry/probe.js";
import type { SpikeRuntime } from "./foundry/runtime.js";

const rt: SpikeRuntime = {
  ready: false,
  initError: null,
  sessionId: newSessionId(),
  store: null,
  writer: null,
  ledger: null,
  capture: null,
  recovery: null,
  probe: null,
  marks: 0,
  lastImport: null,
  lastExport: null,
};

let Panel: any = null;

function openPanel(): void {
  if (!game.user?.isGM) {
    ui?.notifications?.warn?.("The S03 spike panel is GM-only.");
    return;
  }
  if (!Panel) Panel = createPanelClass(rt);
  new Panel().render({ force: true });
}

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, SETTING_WRITER, {
    name: "S03 designated writer (user id)",
    scope: "world",
    config: false,
    type: String,
    default: "",
  });
  Panel = createPanelClass(rt);
  game.settings.registerMenu(MODULE_ID, "panel", {
    name: "S03 spike panel",
    label: "Open S03 spike panel",
    hint: "GM-only throwaway panel: capture status, designated writer, export, mark, test journal import.",
    icon: "fas fa-flask",
    type: Panel,
    restricted: true,
  });
});

Hooks.once("ready", async () => {
  try {
    // Both storage mechanisms are namespaced per world: Foundry serves every world from the same origin.
    const worldNs = worldNamespace();
    const store = await openEventStore({ dbName: worldDbName(worldNs) });
    const ledger = new IssueLedger(window.localStorage, rt.sessionId, worldNs);
    // Recovery first: measure what earlier page loads lost before this one starts issuing.
    rt.recovery = await recover(store, ledger.snapshot(), rt.sessionId);
    const writer = new BufferedWriter((batch) => store.append(batch), DEFAULT_FLUSH_POLICY);
    writer.attachLifecycle(window, document);
    const capture = new CaptureController(rt.sessionId, writer, ledger, thisClientWrites);
    Object.assign(rt, { store, ledger, writer, capture, ready: true });
    rt.probe = registerProbes(capture, Hooks);
  } catch (err) {
    rt.initError = err instanceof Error ? err.message : String(err);
    console.error(`${MODULE_ID} | init failed`, err);
  }

  const mod = game.modules.get(MODULE_ID);
  if (mod) {
    mod.api = {
      open: openPanel,
      exportEvents: () => exportEvents(rt),
      flush: () => rt.writer?.flush("manual"),
      stats: () => ({
        sessionId: rt.sessionId,
        writes: thisClientWrites(),
        issued: rt.capture?.issued ?? 0,
        ignored: rt.capture?.ignored ?? 0,
        writer: rt.writer?.stats ?? null,
        recovery: rt.recovery,
        fires: rt.capture?.fires ?? {},
        emitted: rt.capture?.emitted ?? {},
        pausedDrops: rt.capture?.pausedDrops ?? 0,
        probeErrors: rt.probe?.errors ?? {},
      }),
      /**
       * Spike-only reset between measurement runs (GM console), for the current world only: pauses capture, discards
       * pending writes, clears records and this world's ledger, restarts the counters. Close other tabs first.
       */
      clearStore: async () => {
        if (!game.user?.isGM) throw new Error("GM only");
        if (!rt.capture || !rt.writer || !rt.store || !rt.ledger) throw new Error("spike not ready");
        const result = await resetMeasurement({ capture: rt.capture, writer: rt.writer, store: rt.store, ledger: rt.ledger });
        rt.marks = 0;
        rt.recovery = { persistedTotal: 0, priorSessions: [] };
        rt.lastExport = null;
        return result;
      },
    };
  }
  console.info(`${MODULE_ID} | ready; session ${rt.sessionId}; writer=${thisClientWrites()}`);
});
