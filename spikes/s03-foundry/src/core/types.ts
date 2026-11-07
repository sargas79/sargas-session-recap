export type HookCategory = "rolls" | "damage-healing" | "conditions" | "combat" | "scene" | "item-quantity" | "marker";

export interface CapturedEvent {
  /** Namespaced, source-derived id used for deduplication (see ids.ts). */
  eventId: string;
  /** Local append-only key `<sessionId>#<seq>`. */
  recordId: string;
  sessionId: string;
  seq: number;
  category: HookCategory;
  /** Foundry hook name that produced the event (candidate hook name; verify on v14/PF2e). */
  hook: string;
  /** ISO timestamp from the capturing client's clock. */
  capturedAt: string;
  /** Hash of the Foundry user id that initiated the change, when the hook provides one. */
  initiatorHash: string | null;
  /** True when the discriminator came from a local fallback (Date.now) and cannot dedupe across clients. */
  localDiscriminator: boolean;
  /** Anonymized payload summary (no names, no free text). */
  summary: Record<string, unknown>;
}
