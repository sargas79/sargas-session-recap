/**
 * Prompt templating with delimited slots for untrusted data (T26).
 *
 * A prompt body is trusted instruction text. Transcript text (and anything else derived from a
 * session) is untrusted data: it is never interpolated into instruction text. It can only go into
 * a declared data slot, written in the template as a line of its own:
 *
 * ```text
 * {{data:transcript}}
 * ```
 *
 * At render time each slot becomes a delimited block whose tag carries a fresh random nonce:
 *
 * ```text
 * <untrusted-data-3f9c...e1 name="transcript">
 * ...data...
 * </untrusted-data-3f9c...e1>
 * ```
 *
 * Instruction text may name the tag with `{{data_tag}}` (replaced by `untrusted-data-<nonce>`), so
 * the model is told which closing tag is real. No other `{{`/`}}` sequence is allowed in a body.
 *
 * Why data cannot break out of its block:
 * 1. Rendering is a single pass over the parsed template; data is never scanned for placeholders,
 *    so `{{data:...}}` or `{{data_tag}}` inside data stays literal text.
 * 2. Any `<untrusted-data` or `</untrusted-data` inside data (any case) is escaped to
 *    `&lt;untrusted-data` / `&lt;/untrusted-data`, so data cannot open or close any data tag.
 * 3. The nonce is 128 random bits per render and is re-drawn if the data happens to contain it, so
 *    data cannot forge the closing tag even without the escaping.
 */
import { randomBytes } from 'node:crypto';
import { PromptError } from './errors.ts';

/** Tag-name prefix of an untrusted-data block. */
export const DATA_TAG_PREFIX = 'untrusted-data';

const SLOT_NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;
const SLOT_LINE_RE = /^\{\{data:([^{}]*)\}\}$/;
const DATA_TAG_PLACEHOLDER = '{{data_tag}}';
const NONCE_RE = /^[0-9a-f]{32,64}$/;
/** Matches what could open or close a data tag inside data: `<untrusted-data`, `</untrusted-data`. */
const TAG_LIKE_RE = /<(\s*\/?\s*)(untrusted-data)/giu;
const MAX_NONCE_DRAWS = 8;

export type TemplatePart =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'data-tag' }
  | { readonly kind: 'slot'; readonly name: string };

export interface ParsedTemplate {
  readonly parts: readonly TemplatePart[];
  /** Slot names in the order they appear (each exactly once). */
  readonly slots: readonly string[];
}

export function isSlotName(value: string): boolean {
  return SLOT_NAME_RE.test(value);
}

/**
 * Parses a normalized (LF) prompt body. Throws `PROMPT_INVALID` (naming `where`) when a slot is not
 * on a line of its own, a slot name is invalid or repeated, or any other `{{`/`}}` appears.
 */
export function parseTemplate(body: string, where: string): ParsedTemplate {
  const parts: TemplatePart[] = [];
  const slots: string[] = [];
  const lines = body.split('\n');
  let text = '';
  const flush = (): void => {
    if (text !== '') parts.push({ kind: 'text', text });
    text = '';
  };
  lines.forEach((line, index) => {
    const lineNo = index + 1;
    const last = index === lines.length - 1;
    const slot = SLOT_LINE_RE.exec(line);
    if (slot !== null) {
      const name = slot[1] ?? '';
      if (!isSlotName(name)) {
        throw new PromptError(
          'PROMPT_INVALID',
          `${where}: body line ${String(lineNo)}: data slot name must match ${SLOT_NAME_RE.source}`,
        );
      }
      if (slots.includes(name)) {
        throw new PromptError(
          'PROMPT_INVALID',
          `${where}: body line ${String(lineNo)}: data slot ${name} appears more than once`,
        );
      }
      slots.push(name);
      flush();
      parts.push({ kind: 'slot', name });
      if (!last) text += '\n';
      return;
    }
    const pieces = line.split(DATA_TAG_PLACEHOLDER);
    pieces.forEach((piece, i) => {
      if (piece.includes('{{') || piece.includes('}}')) {
        throw new PromptError(
          'PROMPT_INVALID',
          `${where}: body line ${String(lineNo)}: only {{data_tag}} may appear inline; a data slot {{data:<name>}} must be alone on its line`,
        );
      }
      text += piece;
      if (i < pieces.length - 1) {
        flush();
        parts.push({ kind: 'data-tag' });
      }
    });
    if (!last) text += '\n';
  });
  flush();
  return { parts, slots };
}

/** Escapes anything in data that could open or close a data tag. */
export function escapeData(data: string): string {
  return data.replace(TAG_LIKE_RE, '&lt;$1$2');
}

export function randomNonce(): string {
  return randomBytes(16).toString('hex');
}

export interface RenderTemplateOptions {
  /** Test seam: nonce source. Must return 32-64 lowercase hex characters. */
  readonly nonce?: (() => string) | undefined;
}

export interface RenderedTemplate {
  readonly text: string;
  /** The nonce of this render; the data tag is `untrusted-data-<nonce>`. */
  readonly nonce: string;
  readonly tag: string;
}

/**
 * Renders a parsed template. `data` must have exactly the template's slots, each a string.
 * Throws `PROMPT_DATA_INVALID` otherwise (naming slots only, never data).
 */
export function renderTemplate(
  template: ParsedTemplate,
  data: Readonly<Record<string, unknown>>,
  where: string,
  options: RenderTemplateOptions = {},
): RenderedTemplate {
  const input: unknown = data;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new PromptError('PROMPT_DATA_INVALID', `${where}: data must be an object of slots`);
  }
  const given = Object.keys(data);
  const unknown = given.filter((k) => !template.slots.includes(k));
  if (unknown.length > 0) {
    throw new PromptError(
      'PROMPT_DATA_INVALID',
      `${where}: unknown data slot(s) ${unknown.map((k) => JSON.stringify(k)).join(', ')}; declared: ${template.slots.join(', ') || '(none)'}`,
    );
  }
  const values = new Map<string, string>();
  for (const slot of template.slots) {
    const value = Object.hasOwn(data, slot) ? data[slot] : undefined;
    if (typeof value !== 'string') {
      throw new PromptError(
        'PROMPT_DATA_INVALID',
        `${where}: data slot ${slot} is missing or not a string`,
      );
    }
    values.set(slot, escapeData(value));
  }

  const draw = options.nonce ?? randomNonce;
  const all = [...values.values()].join('\n').toLowerCase();
  let nonce: string | undefined;
  for (let i = 0; i < MAX_NONCE_DRAWS && nonce === undefined; i++) {
    const candidate = draw();
    if (!NONCE_RE.test(candidate)) {
      throw new PromptError('PROMPT_DATA_INVALID', `${where}: nonce must be 32-64 lowercase hex`);
    }
    if (!all.includes(candidate)) nonce = candidate;
  }
  if (nonce === undefined) {
    throw new PromptError(
      'PROMPT_DATA_INVALID',
      `${where}: could not draw a nonce that does not occur in the data`,
    );
  }

  const tag = `${DATA_TAG_PREFIX}-${nonce}`;
  let text = '';
  for (const part of template.parts) {
    switch (part.kind) {
      case 'text':
        text += part.text;
        break;
      case 'data-tag':
        text += tag;
        break;
      case 'slot': {
        const value = values.get(part.name) ?? '';
        const body = value.endsWith('\n') || value === '' ? value : `${value}\n`;
        text += `<${tag} name="${part.name}">\n${body}</${tag}>`;
        break;
      }
    }
  }
  return { text, nonce, tag };
}
