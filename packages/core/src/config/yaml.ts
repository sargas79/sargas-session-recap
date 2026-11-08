/**
 * Safe YAML parsing for config files.
 *
 * - YAML 1.2 core schema only; no custom tags. Any explicit tag (`!foo`, `!!binary`, even `!!str`)
 *   is rejected, so nothing but plain JSON-compatible data can come out.
 * - Anchors, aliases and merge keys are rejected (no alias expansion attacks, no hidden sharing).
 * - Duplicate keys and multiple documents are errors. Mapping keys must be plain strings.
 * - Error messages are our own, keyed on the YAML error code, with line/column only. The parser's
 *   messages are never forwarded because some of them quote source text.
 */
import {
  isAlias,
  isMap,
  isNode,
  isScalar,
  isSeq,
  LineCounter,
  parseDocument,
  visit,
  type Document,
  type Node as YamlNode,
} from 'yaml';
import type { ConfigIssue } from './errors.ts';

export interface ParsedYaml {
  readonly value: unknown;
  readonly doc: Document;
  readonly lines: LineCounter;
}

export type YamlParseResult =
  | { ok: true; parsed: ParsedYaml }
  | { ok: false; code: 'CONFIG_YAML_SYNTAX' | 'CONFIG_YAML_FORBIDDEN'; issues: ConfigIssue[] };

const MAX_ISSUES = 50;

const YAML_ERROR_TEXT: Readonly<Record<string, string>> = {
  DUPLICATE_KEY: 'duplicate key in mapping',
  MULTIPLE_DOCS: 'file must contain exactly one YAML document',
  BAD_INDENT: 'bad indentation',
  BLOCK_AS_IMPLICIT_KEY: 'block value used as an implicit key',
  MISSING_CHAR: 'missing a closing character',
  UNEXPECTED_TOKEN: 'unexpected token',
  MULTILINE_IMPLICIT_KEY: 'implicit keys must be on a single line',
  TAB_AS_INDENT: 'tabs are not allowed as indentation',
  TAG_RESOLVE_FAILED: 'custom tags are not allowed',
  KEY_OVER_1024_CHARS: 'key is too long',
};

function position(lines: LineCounter, offset: number | undefined): { line?: number; col?: number } {
  if (offset === undefined) return {};
  const pos = lines.linePos(offset);
  return { line: pos.line, col: pos.col };
}

function nodeOffset(node: unknown): number | undefined {
  return isNode(node) && node.range !== undefined && node.range !== null
    ? node.range[0]
    : undefined;
}

/** Parse YAML text. Never throws on bad input; never echoes source text in issues. */
export function parseYaml(text: string): YamlParseResult {
  const lines = new LineCounter();
  const doc = parseDocument(text, {
    schema: 'core',
    customTags: [],
    uniqueKeys: true,
    merge: false,
    strict: true,
    prettyErrors: false,
    lineCounter: lines,
  });

  const syntax: ConfigIssue[] = [];
  for (const err of [...doc.errors, ...doc.warnings]) {
    const message = YAML_ERROR_TEXT[err.code] ?? 'YAML syntax error';
    syntax.push({ path: '', keyword: `yaml:${err.code}`, message, ...position(lines, err.pos[0]) });
    if (syntax.length >= MAX_ISSUES) break;
  }
  if (syntax.length > 0) return { ok: false, code: 'CONFIG_YAML_SYNTAX', issues: syntax };

  const forbidden: ConfigIssue[] = [];
  const add = (keyword: string, message: string, node: unknown): void => {
    if (forbidden.length < MAX_ISSUES) {
      forbidden.push({ path: '', keyword, message, ...position(lines, nodeOffset(node)) });
    }
  };
  visit(doc, {
    Alias(_key, node) {
      add('yaml:alias', 'anchors and aliases are not allowed', node);
    },
    Pair(_key, pair) {
      const k = pair.key;
      if (isScalar(k) && k.value === '<<') add('yaml:merge', 'merge keys are not allowed', k);
      else if (!isScalar(k) || typeof k.value !== 'string') {
        add('yaml:key', 'mapping keys must be plain strings', k ?? pair.value);
      }
    },
    Node(_key, node: YamlNode) {
      if (node.tag !== undefined) add('yaml:tag', 'explicit tags are not allowed', node);
      if (!isAlias(node) && node.anchor !== undefined) {
        add('yaml:anchor', 'anchors and aliases are not allowed', node);
      }
    },
  });
  if (forbidden.length > 0) return { ok: false, code: 'CONFIG_YAML_FORBIDDEN', issues: forbidden };

  // Aliases were rejected above; maxAliasCount 0 is a second guard.
  const value: unknown = doc.toJS({ maxAliasCount: 0 });
  return { ok: true, parsed: { value, doc, lines } };
}

/**
 * Best-effort line/column for a JSON Pointer produced by the contract validator. Stops at the
 * first masked (`<key>`) or missing segment and reports the deepest node found.
 */
export function locate(parsed: ParsedYaml, pointer: string): { line?: number; col?: number } {
  const segments = pointer === '' ? [] : pointer.split('/').slice(1);
  let node: unknown = parsed.doc.contents;
  for (const seg of segments) {
    if (seg === '<key>') break;
    let next: unknown;
    if (isMap(node)) next = node.get(seg, true);
    else if (isSeq(node) && /^\d+$/.test(seg)) next = node.get(Number(seg), true);
    if (next === undefined) break;
    node = next;
  }
  return position(parsed.lines, nodeOffset(node));
}
