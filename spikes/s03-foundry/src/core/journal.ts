import { fnv1a32, MODULE_ID } from "./ids.js";

/**
 * GM-only test journal import: input validation, sanitization and JournalEntry creation payload.
 *
 * Input is plain text only. Anything that looks like markup, a script URL, a Foundry enricher (`@UUID[...]`,
 * `[[/r ...]]`) or a Handlebars expression is *rejected* (not stripped), and accepted text is HTML-escaped anyway.
 */

export const IMPORT_SCHEMA = "sargas-recap-spike/test-journal@1";
export const MAX_FILE_BYTES = 256 * 1024;
const MAX_NAME = 120;
const MAX_PAGES = 20;
const MAX_PARAGRAPHS = 200;
const MAX_PARAGRAPH = 4000;

export interface ImportPage {
  name: string;
  paragraphs: string[];
}

export interface ImportInput {
  schema: typeof IMPORT_SCHEMA;
  name: string;
  pages: ImportPage[];
}

export type ValidationResult = { ok: true; value: ImportInput } | { ok: false; errors: string[] };

// eslint-disable-next-line no-control-regex -- rejecting control characters is the point
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const BIDI_RE = /[\u202A-\u202E\u2066-\u2069]/;
const UNSAFE_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/<\s*[A-Za-z!/?]/, "HTML/XML markup is not allowed"],
  [/(?:java|vb)\s*script\s*:/i, "script URLs are not allowed"],
  [/data\s*:\s*[a-z]+\/[a-z0-9.+-]+/i, "data: URLs are not allowed"],
  [/\bon[a-z]+\s*=/i, "inline event-handler-like text is not allowed"],
  [/\[\[/, "Foundry inline roll/enricher syntax ([[...]]) is not allowed"],
  [/@[A-Za-z]+\[/, "Foundry enricher syntax (@Name[...]) is not allowed"],
  [/\{\{/, "Handlebars expressions are not allowed"],
];

function checkText(field: string, value: unknown, max: number, errors: string[], allowNewlines: boolean): string | null {
  if (typeof value !== "string") {
    errors.push(`${field}: must be a string`);
    return null;
  }
  const v = value.normalize("NFC");
  if (v.trim().length === 0) errors.push(`${field}: must not be empty`);
  if (v.length > max) errors.push(`${field}: exceeds ${max} characters`);
  if (CONTROL_RE.test(v)) errors.push(`${field}: control characters are not allowed`);
  if (!allowNewlines && /[\r\n\t]/.test(v)) errors.push(`${field}: line breaks are not allowed`);
  if (BIDI_RE.test(v)) errors.push(`${field}: bidirectional override characters are not allowed`);
  for (const [re, msg] of UNSAFE_PATTERNS) if (re.test(v)) errors.push(`${field}: ${msg}`);
  return v;
}

function checkKeys(field: string, obj: Record<string, unknown>, allowed: readonly string[], errors: string[]): void {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) errors.push(`${field}: unknown key "${k}"`);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function validateImport(raw: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isPlainObject(raw)) return { ok: false, errors: ["root: must be a JSON object"] };
  checkKeys("root", raw, ["schema", "name", "pages"], errors);
  if (raw.schema !== IMPORT_SCHEMA) errors.push(`schema: must be "${IMPORT_SCHEMA}"`);
  const name = checkText("name", raw.name, MAX_NAME, errors, false);
  const pages: ImportPage[] = [];
  if (!Array.isArray(raw.pages) || raw.pages.length === 0) {
    errors.push("pages: must be a non-empty array");
  } else if (raw.pages.length > MAX_PAGES) {
    errors.push(`pages: at most ${MAX_PAGES} pages`);
  } else {
    raw.pages.forEach((p: unknown, i: number) => {
      const f = `pages[${i}]`;
      if (!isPlainObject(p)) return void errors.push(`${f}: must be an object`);
      checkKeys(f, p, ["name", "paragraphs"], errors);
      const pName = checkText(`${f}.name`, p.name, MAX_NAME, errors, false);
      const paras: string[] = [];
      if (!Array.isArray(p.paragraphs) || p.paragraphs.length === 0) {
        errors.push(`${f}.paragraphs: must be a non-empty array`);
      } else if (p.paragraphs.length > MAX_PARAGRAPHS) {
        errors.push(`${f}.paragraphs: at most ${MAX_PARAGRAPHS} paragraphs`);
      } else {
        p.paragraphs.forEach((t: unknown, j: number) => {
          const v = checkText(`${f}.paragraphs[${j}]`, t, MAX_PARAGRAPH, errors, true);
          if (v !== null) paras.push(v);
        });
      }
      if (pName !== null) pages.push({ name: pName.trim(), paragraphs: paras });
    });
  }
  if (errors.length > 0 || name === null) return { ok: false, errors };
  return { ok: true, value: { schema: IMPORT_SCHEMA, name: name.trim(), pages } };
}

/** Parse + validate raw file text (size-checked before JSON.parse). */
export function parseImportFile(text: string): ValidationResult {
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > MAX_FILE_BYTES) return { ok: false, errors: [`file: exceeds ${MAX_FILE_BYTES} bytes`] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (err) {
    return { ok: false, errors: [`file: invalid JSON (${err instanceof Error ? err.message : String(err)})`] };
  }
  return validateImport(parsed);
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function paragraphsToHtml(paragraphs: readonly string[]): string {
  return paragraphs.map((p) => `<p>${escapeHtml(p).replace(/\r?\n/g, "<br>")}</p>`).join("");
}

/** Mirrors CONST.DOCUMENT_OWNERSHIP_LEVELS; main.ts passes the runtime CONST values so a v14 change is caught. */
export interface OwnershipLevels {
  INHERIT: number;
  NONE: number;
  OWNER: number;
}

export const DEFAULT_OWNERSHIP_LEVELS: OwnershipLevels = Object.freeze({ INHERIT: -1, NONE: 0, OWNER: 3 });

export interface BuildOptions {
  gmUserId: string;
  levels?: OwnershipLevels;
  /** CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML (1 in v11-v13; verify on v14). */
  htmlFormat?: number;
  importedAt?: string;
}

export interface JournalPagePayload {
  name: string;
  type: "text";
  sort: number;
  ownership: Record<string, number>;
  text: { content: string; format: number };
}

export interface JournalPayload {
  name: string;
  ownership: Record<string, number>;
  pages: JournalPagePayload[];
  flags: Record<string, Record<string, unknown>>;
}

/**
 * Entry *and every page* get `{ default: NONE, [gmUserId]: OWNER }`. Pages are set explicitly instead of relying on
 * INHERIT so a player cannot see a page even if the entry ownership is later changed by mistake.
 */
export function buildJournalPayload(input: ImportInput, opts: BuildOptions): JournalPayload {
  if (!/^[A-Za-z0-9]{16}$/.test(opts.gmUserId)) throw new Error("gmUserId must be a Foundry document id");
  const levels = opts.levels ?? DEFAULT_OWNERSHIP_LEVELS;
  const ownership = (): Record<string, number> => ({ default: levels.NONE, [opts.gmUserId]: levels.OWNER });
  const contentHash = fnv1a32(JSON.stringify(input));
  return {
    name: input.name, // validated plain text (markup rejected); Foundry renders names as text
    ownership: ownership(),
    pages: input.pages.map((p, i) => ({
      name: p.name,
      type: "text",
      sort: (i + 1) * 100000,
      ownership: ownership(),
      text: { content: paragraphsToHtml(p.paragraphs), format: opts.htmlFormat ?? 1 },
    })),
    flags: {
      [MODULE_ID]: {
        source: "s03-spike-import",
        schema: IMPORT_SCHEMA,
        contentHash,
        importedAt: opts.importedAt ?? new Date().toISOString(),
      },
    },
  };
}

/** Returns human-readable violations; empty array means GM-only. Usable on payloads and on created documents. */
export function gmOnlyViolations(
  label: string,
  ownership: Record<string, number> | undefined,
  gmUserIds: readonly string[],
  levels: OwnershipLevels = DEFAULT_OWNERSHIP_LEVELS,
): string[] {
  const v: string[] = [];
  if (!ownership) return [`${label}: ownership missing`];
  if (ownership.default !== levels.NONE) v.push(`${label}: default ownership is ${String(ownership.default)}, expected NONE`);
  for (const [user, level] of Object.entries(ownership)) {
    if (user === "default" || gmUserIds.includes(user)) continue;
    if (level > levels.NONE) v.push(`${label}: non-GM user ${user} has level ${level}`);
  }
  return v;
}
