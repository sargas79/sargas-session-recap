/**
 * Hook probe. Every hook name and every payload path below is a CANDIDATE (verify on v14/PF2e) — see
 * src/core/hook-catalog.ts. Probes never throw into Foundry: each handler is wrapped and errors are counted.
 */
import { anonymize, changedPaths, getPath, hashId } from "../core/anonymize.js";
import type { CaptureController, CaptureInput } from "../core/capture.js";
import { uniqueHookNames } from "../core/hook-catalog.js";

export interface ProbeState {
  errors: Record<string, number>;
  lastError: string | null;
  registered: Array<{ hook: string; id: number }>;
}

type Doc = any;

function initiator(userId: unknown): string | null {
  return typeof userId === "string" && userId ? hashId(userId) : null;
}

/** Discriminator identical on all clients if `_stats.modifiedTime` exists (candidate); else local fallback. */
function updateDiscriminator(doc: Doc): { discriminator: string | number; localDiscriminator: boolean } {
  const mt = getPath(doc, "_stats.modifiedTime");
  if (typeof mt === "number" && Number.isFinite(mt)) return { discriminator: mt, localDiscriminator: false };
  return { discriminator: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, localDiscriminator: true };
}

function src(doc: Doc): string {
  const uuid = typeof doc?.uuid === "string" ? doc.uuid : String(doc?.id ?? "unknown");
  return hashId(uuid);
}

function optionKeys(options: unknown): string[] {
  return options && typeof options === "object" ? Object.keys(options as object).sort() : [];
}

function chatSummary(message: Doc): Record<string, unknown> {
  const rolls = Array.isArray(message?.rolls) ? message.rolls : [];
  return {
    documentName: "ChatMessage",
    rollCount: rolls.length,
    rolls: rolls.slice(0, 5).map((r: Doc) => ({
      total: typeof r?.total === "number" ? r.total : null,
      class: r?.constructor?.name ?? null,
      dice: Array.isArray(r?.dice) ? r.dice.map((d: Doc) => ({ faces: d?.faces ?? null, number: d?.number ?? null })) : [],
    })),
    pf2eContext: anonymize(getPath(message, "flags.pf2e.context") ?? null),
    pf2eFlagKeys: Object.keys((getPath(message, "flags.pf2e") as object | undefined) ?? {}).sort(),
    appliedDamage: anonymize(getPath(message, "flags.pf2e.appliedDamage") ?? null),
    isRoll: message?.isRoll ?? null,
  };
}

function itemCategory(item: Doc, changed: unknown): Array<"conditions" | "item-quantity"> {
  const out: Array<"conditions" | "item-quantity"> = [];
  if (item?.type === "condition") out.push("conditions");
  if (changed !== undefined && getPath(changed, "system.quantity") !== undefined) out.push("item-quantity");
  return out;
}

export function registerProbes(capture: CaptureController, hooks: any): ProbeState {
  const state: ProbeState = { errors: {}, lastError: null, registered: [] };

  const on = (hook: string, fn: (...args: any[]) => void) => {
    const wrapped = (...args: any[]) => {
      try {
        fn(...args);
      } catch (err) {
        state.errors[hook] = (state.errors[hook] ?? 0) + 1;
        state.lastError = `${hook}: ${err instanceof Error ? err.message : String(err)}`;
      }
    };
    const id = hooks.on(hook, wrapped);
    state.registered.push({ hook, id });
  };

  const emit = (input: CaptureInput) => capture.capture(input);

  // --- rolls + damage/healing chat cards -------------------------------------------------------------------------
  on("createChatMessage", (message: Doc, _options: unknown, userId: unknown) => {
    const summary = chatSummary(message);
    const ctxType = getPath(message, "flags.pf2e.context.type");
    const isDamageCard = ctxType === "damage-roll" || getPath(message, "flags.pf2e.appliedDamage") !== undefined;
    emit({
      category: isDamageCard ? "damage-healing" : "rolls",
      hook: "createChatMessage",
      kind: "chat",
      source: src(message),
      discriminator: "create",
      initiatorHash: initiator(userId),
      summary,
    });
  });

  // --- damage/healing via HP updates -------------------------------------------------------------------------------
  on("updateActor", (actor: Doc, changed: unknown, options: unknown, userId: unknown) => {
    const hp = getPath(changed, "system.attributes.hp");
    if (hp === undefined) return;
    emit({
      category: "damage-healing",
      hook: "updateActor",
      kind: "actor-hp",
      source: src(actor),
      ...updateDiscriminator(actor),
      initiatorHash: initiator(userId),
      summary: {
        documentName: "Actor",
        actorType: anonymize(actor?.type, "type"),
        hpChanged: anonymize(hp),
        hpAfter: anonymize(getPath(actor, "system.attributes.hp") ?? null),
        changedPaths: changedPaths(changed),
        optionKeys: optionKeys(options),
        damageTakenOption: anonymize(getPath(options, "damageTaken") ?? null),
      },
    });
  });

  // --- conditions (PF2e condition items) + item quantity -----------------------------------------------------------
  for (const hook of ["createItem", "updateItem", "deleteItem"] as const) {
    on(hook, (item: Doc, a: unknown, b: unknown, c: unknown) => {
      const changed = hook === "updateItem" ? a : undefined;
      const options = hook === "updateItem" ? b : a;
      const userId = hook === "updateItem" ? c : b;
      for (const category of itemCategory(item, changed)) {
        const disc =
          hook === "updateItem" ? updateDiscriminator(item) : { discriminator: hook, localDiscriminator: false };
        emit({
          category,
          hook,
          kind: category === "conditions" ? `condition-${hook}` : "item-quantity",
          source: src(item),
          ...disc,
          initiatorHash: initiator(userId),
          summary: {
            documentName: "Item",
            type: anonymize(item?.type, "type"),
            slug: anonymize(getPath(item, "system.slug") ?? null, "slug"),
            conditionValue: anonymize(getPath(item, "system.value.value") ?? null),
            quantityAfter: anonymize(getPath(item, "system.quantity") ?? null),
            quantityChanged: anonymize(getPath(changed, "system.quantity") ?? null),
            parentType: anonymize(item?.parent?.documentName ?? null, "documentName"),
            changedPaths: changed === undefined ? [] : changedPaths(changed),
            optionKeys: optionKeys(options),
          },
        });
      }
    });
  }

  for (const hook of ["createActiveEffect", "deleteActiveEffect"] as const) {
    on(hook, (effect: Doc, options: unknown, userId: unknown) => {
      const statuses = effect?.statuses instanceof Set ? [...effect.statuses] : (effect?.statuses ?? []);
      emit({
        category: "conditions",
        hook,
        kind: `effect-${hook}`,
        source: src(effect),
        discriminator: hook,
        initiatorHash: initiator(userId),
        summary: {
          documentName: "ActiveEffect",
          statuses: anonymize(statuses, "options"),
          parentType: anonymize(effect?.parent?.documentName ?? null, "documentName"),
          optionKeys: optionKeys(options),
        },
      });
    });
  }

  // --- combat --------------------------------------------------------------------------------------------------------
  on("combatStart", (combat: Doc, updateData: unknown) => {
    emit({
      category: "combat",
      hook: "combatStart",
      kind: "combat-start",
      source: src(combat),
      discriminator: "start",
      initiatorHash: null,
      summary: { documentName: "Combat", updateData: anonymize(updateData), combatants: combat?.combatants?.size ?? null },
    });
  });
  for (const hook of ["combatRound", "combatTurn"] as const) {
    on(hook, (combat: Doc, updateData: unknown, updateOptions: unknown) => {
      const r = getPath(updateData, "round") ?? combat?.round;
      const t = getPath(updateData, "turn") ?? combat?.turn;
      emit({
        category: "combat",
        hook,
        kind: hook === "combatRound" ? "combat-round" : "combat-turn",
        source: src(combat),
        discriminator: `${String(r)}.${String(t)}`,
        initiatorHash: null,
        summary: {
          documentName: "Combat",
          updateData: anonymize(updateData),
          direction: anonymize(getPath(updateOptions, "direction") ?? null),
          optionKeys: optionKeys(updateOptions),
        },
      });
    });
  }
  on("updateCombat", (combat: Doc, changed: unknown, options: unknown, userId: unknown) => {
    const paths = changedPaths(changed);
    if (!paths.some((p) => p === "round" || p === "turn" || p === "active" || p.startsWith("started"))) return;
    emit({
      category: "combat",
      hook: "updateCombat",
      kind: "combat-update",
      source: src(combat),
      ...updateDiscriminator(combat),
      initiatorHash: initiator(userId),
      summary: {
        documentName: "Combat",
        changed: anonymize(changed),
        roundAfter: combat?.round ?? null,
        turnAfter: combat?.turn ?? null,
        startedAfter: combat?.started ?? null,
        optionKeys: optionKeys(options),
      },
    });
  });
  on("deleteCombat", (combat: Doc, options: unknown, userId: unknown) => {
    emit({
      category: "combat",
      hook: "deleteCombat",
      kind: "combat-end",
      source: src(combat),
      discriminator: "delete",
      initiatorHash: initiator(userId),
      summary: { documentName: "Combat", roundAtEnd: combat?.round ?? null, optionKeys: optionKeys(options) },
    });
  });

  // --- scenes --------------------------------------------------------------------------------------------------------
  on("updateScene", (scene: Doc, changed: unknown, options: unknown, userId: unknown) => {
    if (getPath(changed, "active") !== true) return;
    emit({
      category: "scene",
      hook: "updateScene",
      kind: "scene-activate",
      source: src(scene),
      ...updateDiscriminator(scene),
      initiatorHash: initiator(userId),
      summary: { documentName: "Scene", changedPaths: changedPaths(changed), optionKeys: optionKeys(options) },
    });
  });
  on("canvasReady", (canvas: Doc) => {
    // Control sample: fires per client on local view changes; expected NOT to be a reliable activation signal.
    emit({
      category: "scene",
      hook: "canvasReady",
      kind: "canvas-ready",
      source: src(canvas?.scene),
      discriminator: `local-${Date.now()}`,
      localDiscriminator: true,
      initiatorHash: null,
      summary: { documentName: "Scene", hasScene: !!canvas?.scene },
    });
  });

  // Sanity: every catalog hook is registered.
  const registered = new Set(state.registered.map((r) => r.hook));
  for (const h of uniqueHookNames()) if (!registered.has(h)) state.errors[`missing:${h}`] = 1;
  return state;
}
