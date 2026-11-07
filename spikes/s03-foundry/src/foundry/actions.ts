import { exportJsonl } from "../core/export.js";
import { fnv1a32, MODULE_ID } from "../core/ids.js";
import { buildJournalPayload, gmOnlyViolations, parseImportFile, type OwnershipLevels } from "../core/journal.js";
import { isDesignatedWriter } from "../core/writer.js";
import type { ImportOutcome, SpikeRuntime } from "./runtime.js";

export const SETTING_WRITER = "designatedWriter";

/** Hash of the current world id: namespaces IndexedDB, the loss ledger and export filenames. */
export function worldNamespace(): string {
  return fnv1a32(String(game.world?.id ?? "world"));
}

export function currentWriterSetting(): string {
  try {
    return String(game.settings.get(MODULE_ID, SETTING_WRITER) ?? "");
  } catch {
    return "";
  }
}

export function thisClientWrites(): boolean {
  return isDesignatedWriter(game.user?.id, currentWriterSetting());
}

export async function setWriter(userId: string): Promise<void> {
  if (!game.user?.isGM) throw new Error("only a GM can choose the designated writer");
  await game.settings.set(MODULE_ID, SETTING_WRITER, userId);
}

export function mark(rt: SpikeRuntime): boolean {
  if (!rt.capture) return false;
  rt.marks++;
  const ev = rt.capture.capture({
    category: "marker",
    hook: "manual-mark",
    kind: "mark",
    source: rt.sessionId,
    discriminator: rt.marks,
    initiatorHash: null,
    summary: { markNumber: rt.marks },
  });
  return ev !== null;
}

function download(filename: string, text: string, type: string): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function exportEvents(rt: SpikeRuntime): Promise<void> {
  if (!rt.store) throw new Error("store not open");
  await rt.writer?.flush("manual");
  const result = exportJsonl(await rt.store.getAll());
  rt.lastExport = { at: new Date().toISOString(), unique: result.unique, duplicates: result.duplicates, invalid: result.invalid };
  const world = worldNamespace();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  download(`s03-events-${world}-${stamp}.jsonl`, result.jsonl, "application/x-ndjson");
}

function ownershipLevels(): OwnershipLevels {
  const L = CONST?.DOCUMENT_OWNERSHIP_LEVELS ?? {};
  return {
    INHERIT: typeof L.INHERIT === "number" ? L.INHERIT : -1,
    NONE: typeof L.NONE === "number" ? L.NONE : 0,
    OWNER: typeof L.OWNER === "number" ? L.OWNER : 3,
  };
}

/** Reads a local file chosen by the GM and creates a GM-only JournalEntry. Candidate APIs: verify on v14. */
export async function importJournalFile(rt: SpikeRuntime, file: File): Promise<ImportOutcome> {
  const at = new Date().toISOString();
  if (!game.user?.isGM) return (rt.lastImport = { at, ok: false, errors: ["only a GM may import"], violations: [] });
  const parsed = parseImportFile(await file.text());
  if (!parsed.ok) return (rt.lastImport = { at, ok: false, errors: parsed.errors, violations: [] });

  const levels = ownershipLevels();
  const payload = buildJournalPayload(parsed.value, {
    gmUserId: game.user.id,
    levels,
    htmlFormat: CONST?.JOURNAL_ENTRY_PAGE_FORMATS?.HTML ?? 1,
  });
  const JournalEntryCls = foundry?.documents?.JournalEntry ?? getDocumentClass("JournalEntry");
  const entry = await JournalEntryCls.create(payload);
  if (!entry) return (rt.lastImport = { at, ok: false, errors: ["JournalEntry.create returned nothing"], violations: [] });

  // Re-read the created documents: what the server stored is the evidence, not what we sent.
  const gmIds: string[] = game.users.filter((u: any) => u.isGM).map((u: any) => u.id);
  const violations = [...gmOnlyViolations("entry", entry.ownership, gmIds, levels)];
  const pages: any[] = entry.pages?.contents ?? [];
  for (const page of pages) violations.push(...gmOnlyViolations(`page ${page.id}`, page.ownership, gmIds, levels));
  for (const user of game.users.filter((u: any) => !u.isGM)) {
    if (entry.testUserPermission?.(user, "LIMITED")) violations.push(`entry: player ${user.id} has >= LIMITED`);
    for (const page of pages) {
      if (page.testUserPermission?.(user, "LIMITED")) violations.push(`page ${page.id}: player ${user.id} has >= LIMITED`);
    }
  }
  return (rt.lastImport = { at, ok: true, journalId: entry.id, pageCount: pages.length, errors: [], violations });
}
