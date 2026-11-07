import type { HookCategory } from "./types.js";

/**
 * Candidate hooks the probe registers. EVERY entry is a candidate: names, argument order and payload fields come
 * from general Foundry/PF2e knowledge of earlier versions and MUST be verified on the host's v14 + PF2e build.
 * Nothing here is evidence of support.
 */
export interface HookCandidate {
  category: HookCategory;
  hook: string;
  /** What the probe looks at; all field paths are candidates to verify. */
  looksAt: string;
  verification: "candidate, verify on v14/PF2e";
}

const C = "candidate, verify on v14/PF2e" as const;

export const HOOK_CANDIDATES: readonly HookCandidate[] = [
  { category: "rolls", hook: "createChatMessage", looksAt: "message.rolls[], flags.pf2e.context.{type,outcome,unadjustedOutcome}", verification: C },
  { category: "damage-healing", hook: "createChatMessage", looksAt: "flags.pf2e.context.type === 'damage-roll'; flags.pf2e.appliedDamage", verification: C },
  { category: "damage-healing", hook: "updateActor", looksAt: "changed.system.attributes.hp.{value,temp}; update option keys", verification: C },
  { category: "conditions", hook: "createItem", looksAt: "item.type === 'condition' (PF2e conditions as items), system.slug, system.value.value", verification: C },
  { category: "conditions", hook: "updateItem", looksAt: "condition item changed.system.value.value", verification: C },
  { category: "conditions", hook: "deleteItem", looksAt: "item.type === 'condition'", verification: C },
  { category: "conditions", hook: "createActiveEffect", looksAt: "effect.statuses, parent documentName", verification: C },
  { category: "conditions", hook: "deleteActiveEffect", looksAt: "effect.statuses, parent documentName", verification: C },
  { category: "combat", hook: "combatStart", looksAt: "combat.round, combat.turn", verification: C },
  { category: "combat", hook: "combatRound", looksAt: "updateData.round/turn, updateOptions.direction", verification: C },
  { category: "combat", hook: "combatTurn", looksAt: "updateData.round/turn", verification: C },
  { category: "combat", hook: "updateCombat", looksAt: "changed.{round,turn,active}", verification: C },
  { category: "combat", hook: "deleteCombat", looksAt: "combat end (deletion)", verification: C },
  { category: "scene", hook: "updateScene", looksAt: "changed.active === true", verification: C },
  { category: "scene", hook: "canvasReady", looksAt: "local view change only (not activation) - control sample", verification: C },
  { category: "item-quantity", hook: "updateItem", looksAt: "changed.system.quantity", verification: C },
];

export const HOOK_CATEGORIES: readonly HookCategory[] = [
  "rolls",
  "damage-healing",
  "conditions",
  "combat",
  "scene",
  "item-quantity",
];

export function uniqueHookNames(): string[] {
  return [...new Set(HOOK_CANDIDATES.map((h) => h.hook))];
}
