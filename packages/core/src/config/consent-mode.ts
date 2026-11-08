/**
 * The consent switch: `recap config consent on|off <campaign.yaml>`.
 *
 * - `on`  -> `consent_mode: records`: every included speaker needs dated consent records.
 * - `off` -> `consent_mode: implied`: attending the session is consent; only speakers listed in
 *   campaign.yaml are processed.
 *
 * The file is edited in place. Comments, key order, a UTF-8 BOM and CRLF line endings are kept.
 * The edit is validated before it replaces the file, and the file is written atomically.
 */
import { readFile } from 'node:fs/promises';
import { isMap, parseDocument, type Document } from 'yaml';
import { consentModeOf, type ConsentMode } from '@sargas-recap/contracts';
import { writeFileAtomic } from '../package/atomic.ts';
import { loadCampaignConfig, parseCampaignConfig, type LoadOptions } from './load.ts';

export interface ConsentModeChange {
  readonly file: string;
  readonly previous: ConsentMode;
  readonly mode: ConsentMode;
  /** False when the file already had the requested mode (nothing was written). */
  readonly changed: boolean;
}

/** Reads the effective consent mode of a campaign.yaml (validating it). */
export async function readConsentMode(
  file: string,
  options: LoadOptions = {},
): Promise<ConsentMode> {
  const loaded = await loadCampaignConfig(file, options);
  return consentModeOf(loaded.value);
}

/** Rewrites `consent_mode` in campaign.yaml. Throws ConfigError if the file is invalid. */
export async function setConsentMode(
  file: string,
  mode: ConsentMode,
  options: LoadOptions = {},
): Promise<ConsentModeChange> {
  // Validate first: a broken or unsafe file is never rewritten.
  const loaded = await loadCampaignConfig(file, options);
  const previous = consentModeOf(loaded.value);
  if (loaded.value.consent_mode === mode) {
    return { file, previous, mode, changed: false };
  }

  const raw = await readFile(file, 'utf8');
  const bom = raw.startsWith('﻿');
  const body = bom ? raw.slice(1) : raw;
  const crlf = body.includes('\r\n');

  // Edited as a plain (unparsed-typed) document: new nodes are created, not parsed.
  const doc: Document = parseDocument(body.replace(/\r\n/g, '\n'));
  const root = doc.contents;
  if (!isMap(root)) {
    // loadCampaignConfig already guarantees a mapping; keep the type checker honest.
    throw new Error('campaign.yaml root is not a mapping');
  }
  if (root.has('consent_mode')) {
    root.set('consent_mode', mode);
  } else {
    // Put the switch right after `language` so it is easy to find.
    const pair = doc.createPair('consent_mode', mode);
    const at = root.items.findIndex((p) => isKey(p, 'language'));
    root.items.splice(at === -1 ? root.items.length : at + 1, 0, pair);
  }

  let out = doc.toString({ lineWidth: 0 });
  if (crlf) out = out.replace(/\n/g, '\r\n');
  // Same validation as a normal load, so the switch can never produce an invalid file.
  parseCampaignConfig(out, file, options);
  await writeFileAtomic(file, (bom ? '﻿' : '') + out);
  return { file, previous, mode, changed: true };
}

function isKey(pair: unknown, name: string): boolean {
  const key = (pair as { key?: unknown }).key;
  if (typeof key === 'string') return key === name;
  return (key as { value?: unknown } | null)?.value === name;
}
