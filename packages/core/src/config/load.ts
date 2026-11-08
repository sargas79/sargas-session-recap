/**
 * Loader for `campaign.yaml` and `glossary.yaml` (T04).
 *
 * Pipeline: size limit -> strict UTF-8 -> safe YAML (yaml.ts) -> contract schema (Ajv, from
 * @sargas-recap/contracts) -> semantic rules JSON Schema cannot express (unique IDs, date order).
 * Every failure is a {@link ConfigError} listing file + JSON Pointer (+ line/column) per problem;
 * no config value is ever echoed.
 */
import { readFile, stat } from 'node:fs/promises';
import {
  validateContract,
  type CampaignConfig,
  type Glossary,
  type ImportMapping,
  type ValidationIssue,
} from '@sargas-recap/contracts';
import { contentHash, type Sha256 } from './canonical.ts';
import { ConfigError, type ConfigIssue, type ConfigKind } from './errors.ts';
import { locate, parseYaml, type ParsedYaml } from './yaml.ts';

/** Default size limit for one config file. Real configs are a few KiB. */
export const DEFAULT_MAX_CONFIG_BYTES = 1024 * 1024;

export interface LoadOptions {
  /** Reject files larger than this many bytes. Defaults to {@link DEFAULT_MAX_CONFIG_BYTES}. */
  readonly maxBytes?: number;
}

export interface LoadedConfig<T> {
  readonly kind: ConfigKind;
  readonly file: string;
  readonly value: T;
  /** Canonical content hash of `value` (record it per run, T07). */
  readonly hash: Sha256;
}

interface KindTypes {
  'campaign-config': CampaignConfig;
  glossary: Glossary;
  'import-mapping': ImportMapping;
}

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

function tooLarge(kind: ConfigKind, file: string, maxBytes: number): ConfigError {
  return new ConfigError('CONFIG_TOO_LARGE', kind, file, [
    { path: '', keyword: 'size', message: `file is larger than ${String(maxBytes)} bytes` },
  ]);
}

function decode(kind: ConfigKind, file: string, bytes: Uint8Array, maxBytes: number): string {
  if (bytes.byteLength > maxBytes) throw tooLarge(kind, file, maxBytes);
  try {
    // ignoreBOM: false strips a leading UTF-8 BOM (Notepad writes one).
    return UTF8.decode(bytes);
  } catch (cause) {
    throw new ConfigError(
      'CONFIG_NOT_UTF8',
      kind,
      file,
      [{ path: '', keyword: 'encoding', message: 'file is not valid UTF-8' }],
      { cause },
    );
  }
}

function withPosition(parsed: ParsedYaml, issue: ValidationIssue | ConfigIssue): ConfigIssue {
  return {
    path: issue.path,
    keyword: issue.keyword,
    message: issue.message,
    ...locate(parsed, issue.path),
  };
}

function campaignRules(value: CampaignConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const firstIndex = new Map<string, number>();
  value.speakers.forEach((speaker, i) => {
    const seen = firstIndex.get(speaker.speaker_id);
    if (seen === undefined) firstIndex.set(speaker.speaker_id, i);
    else {
      issues.push({
        path: `/speakers/${String(i)}/speaker_id`,
        keyword: 'unique',
        message: `duplicates /speakers/${String(seen)}/speaker_id`,
      });
    }
    (speaker.consent ?? []).forEach((record, j) => {
      if (record.withdrawn_on !== undefined && record.withdrawn_on < record.granted_on) {
        issues.push({
          path: `/speakers/${String(i)}/consent/${String(j)}/withdrawn_on`,
          keyword: 'order',
          message: 'must not be earlier than granted_on',
        });
      }
    });
  });
  return issues;
}

function glossaryRules(value: Glossary): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const firstIndex = new Map<string, number>();
  value.entries.forEach((entry, i) => {
    const seen = firstIndex.get(entry.id);
    if (seen === undefined) firstIndex.set(entry.id, i);
    else {
      issues.push({
        path: `/entries/${String(i)}/id`,
        keyword: 'unique',
        message: `duplicates /entries/${String(seen)}/id`,
      });
    }
  });
  return issues;
}

function importMappingRules(value: ImportMapping): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const firstIndex = new Map<string, number>();
  value.tracks.forEach((track, i) => {
    // Case-insensitive: on Windows `GM.flac` and `gm.flac` are the same file.
    const key = track.file.toLowerCase();
    const seen = firstIndex.get(key);
    if (seen === undefined) firstIndex.set(key, i);
    else {
      issues.push({
        path: `/tracks/${String(i)}/file`,
        keyword: 'unique',
        message: `duplicates /tracks/${String(seen)}/file (names are compared ignoring case)`,
      });
    }
  });
  return issues;
}

function semanticRules(kind: ConfigKind, value: unknown): ConfigIssue[] {
  switch (kind) {
    case 'campaign-config':
      return campaignRules(value as CampaignConfig);
    case 'glossary':
      return glossaryRules(value as Glossary);
    case 'import-mapping':
      return importMappingRules(value as ImportMapping);
  }
}

function parseConfig<K extends ConfigKind>(
  kind: K,
  text: string,
  file: string,
  maxBytes: number,
): LoadedConfig<KindTypes[K]> {
  if (new TextEncoder().encode(text).byteLength > maxBytes) throw tooLarge(kind, file, maxBytes);
  const yaml = parseYaml(text);
  if (!yaml.ok) throw new ConfigError(yaml.code, kind, file, yaml.issues);
  const { parsed } = yaml;

  const result = validateContract(kind, parsed.value);
  if (!result.ok) {
    throw new ConfigError(
      'CONFIG_INVALID',
      kind,
      file,
      result.errors.map((e) => withPosition(parsed, e)),
    );
  }
  const value = result.value as KindTypes[K];
  const semantic = semanticRules(kind, value);
  if (semantic.length > 0) {
    throw new ConfigError(
      'CONFIG_INVALID',
      kind,
      file,
      semantic.map((e) => withPosition(parsed, e)),
    );
  }
  return { kind, file, value, hash: contentHash(value) };
}

async function loadConfig<K extends ConfigKind>(
  kind: K,
  file: string,
  options: LoadOptions,
): Promise<LoadedConfig<KindTypes[K]>> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_CONFIG_BYTES;
  let bytes: Uint8Array;
  try {
    // Check the size before reading so a huge file is never pulled into memory.
    const info = await stat(file);
    if (!info.isFile()) {
      throw new ConfigError('CONFIG_READ_FAILED', kind, file, [
        { path: '', keyword: 'read', message: 'is not a regular file' },
      ]);
    }
    if (info.size > maxBytes) throw tooLarge(kind, file, maxBytes);
    bytes = await readFile(file);
  } catch (cause) {
    if (cause instanceof ConfigError) throw cause;
    const code = (cause as NodeJS.ErrnoException | undefined)?.code;
    const message = code === 'ENOENT' ? 'file not found' : `cannot read file (${code ?? 'error'})`;
    throw new ConfigError(
      'CONFIG_READ_FAILED',
      kind,
      file,
      [{ path: '', keyword: 'read', message }],
      { cause },
    );
  }
  return parseConfig(kind, decode(kind, file, bytes, maxBytes), file, maxBytes);
}

/** Parse and validate `campaign.yaml` text. `file` labels errors. Throws {@link ConfigError}. */
export function parseCampaignConfig(
  text: string,
  file = 'campaign.yaml',
  options: LoadOptions = {},
): LoadedConfig<CampaignConfig> {
  return parseConfig('campaign-config', text, file, options.maxBytes ?? DEFAULT_MAX_CONFIG_BYTES);
}

/** Parse and validate `glossary.yaml` text. `file` labels errors. Throws {@link ConfigError}. */
export function parseGlossary(
  text: string,
  file = 'glossary.yaml',
  options: LoadOptions = {},
): LoadedConfig<Glossary> {
  return parseConfig('glossary', text, file, options.maxBytes ?? DEFAULT_MAX_CONFIG_BYTES);
}

/** Read, parse and validate a `campaign.yaml` file. Throws {@link ConfigError}. */
export function loadCampaignConfig(
  file: string,
  options: LoadOptions = {},
): Promise<LoadedConfig<CampaignConfig>> {
  return loadConfig('campaign-config', file, options);
}

/** Read, parse and validate a `glossary.yaml` file. Throws {@link ConfigError}. */
export function loadGlossary(
  file: string,
  options: LoadOptions = {},
): Promise<LoadedConfig<Glossary>> {
  return loadConfig('glossary', file, options);
}

/** Parse and validate import mapping text (YAML or JSON, T05). Throws {@link ConfigError}. */
export function parseImportMapping(
  text: string,
  file = 'recap-tracks.yaml',
  options: LoadOptions = {},
): LoadedConfig<ImportMapping> {
  return parseConfig('import-mapping', text, file, options.maxBytes ?? DEFAULT_MAX_CONFIG_BYTES);
}

/** Read, parse and validate an import mapping file (T05). Throws {@link ConfigError}. */
export function loadImportMapping(
  file: string,
  options: LoadOptions = {},
): Promise<LoadedConfig<ImportMapping>> {
  return loadConfig('import-mapping', file, options);
}
