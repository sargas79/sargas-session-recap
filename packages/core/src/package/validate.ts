/**
 * Session package validator (T03, ADR-006).
 *
 * Checks, in order:
 * - `manifest.json` against the `manifest` contract (lifecycle/seal/purge rules included);
 * - `fragments.jsonl` and `foundry.jsonl` line by line against their contracts, plus the cross-field
 *   rules JSON Schema cannot express (ADR-004 ID prefixes, manifest scope, duplicates, layout);
 * - every path, lexically and on disk (traversal, Windows edge cases, link escapes, case
 *   collisions);
 * - the seal: every sealed artifact must exist with the sealed size and hash, unless purge
 *   provenance lists it; no source artifact may appear on disk after sealing;
 * - the purge provenance against the seal;
 * - derived run directories (`transcript/`, `classify/`, `recap/`) against their contracts and
 *   their directory names, and leftovers of interrupted atomic writes.
 *
 * The validator only reads. It never echoes field values (see issues.ts).
 */
import { lstat, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  ULID_PATTERN,
  validateContract,
  type ContractName,
  type ContractTypes,
  type LifecycleState,
  type Manifest,
  type ValidationIssue,
} from '@sargas-recap/contracts';
import { isAtomicTempName } from './atomic.ts';
import { sha256File } from './hash.ts';
import {
  INTEGRITY_CODES,
  type PackageIssue,
  type PackageIssueCode,
  type PackageState,
} from './issues.ts';
import {
  UnsafePathError,
  checkRelPath,
  findCaseCollisions,
  realPackageRoot,
  resolveInsidePackage,
  type ResolvedPackagePath,
} from './safe-path.ts';

export const MANIFEST_FILE = 'manifest.json';
export const FRAGMENTS_FILE = 'fragments.jsonl';
export const FOUNDRY_FILE = 'foundry.jsonl';
export const AUDIO_DIR = 'audio';

export type SourceArtifactKind = 'audio-fragment' | 'fragments-index' | 'foundry-events';

/** Kind of a source artifact by its package path (ADR-006), or `undefined` for derived files. */
export function sourceKindOf(rel: string): SourceArtifactKind | undefined {
  if (rel === FRAGMENTS_FILE) return 'fragments-index';
  if (rel === FOUNDRY_FILE) return 'foundry-events';
  if (rel.startsWith(`${AUDIO_DIR}/`)) return 'audio-fragment';
  return undefined;
}

export const MAX_REPORTED_ISSUES = 200;

export interface PackageReport {
  /** The package root as given. */
  readonly root: string;
  /** Lifecycle state when valid, otherwise `corrupt` or `invalid`. */
  readonly state: PackageState;
  /** True when there is no error (warnings allowed). */
  readonly ok: boolean;
  /** Lifecycle from the manifest, when the manifest is valid. */
  readonly lifecycle: LifecycleState | undefined;
  readonly issues: readonly PackageIssue[];
  /** The manifest, when it passed its contract. */
  readonly manifest: Manifest | undefined;
  /** Source artifacts found on disk (`audio/**`, `fragments.jsonl`, `foundry.jsonl`), sorted. */
  readonly sources: readonly string[];
}

const ULID = new RegExp(ULID_PATTERN);
const REVISION = /^[1-9][0-9]{0,15}$/;
const MISSING = Symbol('missing');

class IssueList {
  readonly items: PackageIssue[] = [];
  private truncated = false;

  add(issue: PackageIssue): void {
    if (this.items.length < MAX_REPORTED_ISSUES) {
      this.items.push(issue);
    } else if (!this.truncated) {
      this.truncated = true;
      this.items.push({
        severity: 'error',
        code: 'TRUNCATED',
        file: '.',
        field: '',
        message: `more than ${MAX_REPORTED_ISSUES} issues; fix these and validate again`,
      });
    }
  }

  error(code: PackageIssueCode, file: string, field: string, message: string, line?: number): void {
    this.add({
      severity: 'error',
      code,
      file,
      field,
      message,
      ...(line === undefined ? {} : { line }),
    });
  }

  warn(code: PackageIssueCode, file: string, field: string, message: string, line?: number): void {
    this.add({
      severity: 'warning',
      code,
      file,
      field,
      message,
      ...(line === undefined ? {} : { line }),
    });
  }

  contract(file: string, errors: readonly ValidationIssue[], line?: number): void {
    for (const e of errors) this.error('CONTRACT', file, e.path, e.message, line);
  }
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** Resolves a package path, turning unsafe paths into issues. `undefined` means: reported. */
async function resolveOrReport(
  realRoot: string,
  rel: string,
  issues: IssueList,
  file: string,
  field: string,
): Promise<ResolvedPackagePath | undefined> {
  try {
    return await resolveInsidePackage(realRoot, rel);
  } catch (error) {
    if (error instanceof UnsafePathError) {
      issues.error('UNSAFE_PATH', file, field, error.message);
      return undefined;
    }
    throw error;
  }
}

/** Reads a regular file inside the package as UTF-8, or reports why it cannot. */
async function readPackageText(
  realRoot: string,
  rel: string,
  issues: IssueList,
): Promise<string | typeof MISSING | undefined> {
  const resolved = await resolveOrReport(realRoot, rel, issues, rel, '');
  if (resolved === undefined) return undefined;
  if (!resolved.exists || resolved.real === undefined) return MISSING;
  const info = await stat(resolved.real);
  if (!info.isFile()) {
    issues.error('FILE_NOT_REGULAR', rel, '', 'must be a regular file');
    return undefined;
  }
  try {
    const text = await readFile(resolved.real, 'utf8');
    // Tolerate a UTF-8 byte order mark (Windows editors add one); hashes still cover raw bytes.
    return text.startsWith('﻿') ? text.slice(1) : text;
  } catch {
    issues.error('FILE_UNREADABLE', rel, '', 'cannot be read (locked or no permission)');
    return undefined;
  }
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    // The parser's message quotes the input, so it is never shown.
    return { ok: false };
  }
}

interface JsonlRecord<T> {
  readonly line: number;
  readonly value: T;
}

/** Parses and contract-validates a JSON Lines file. Returns the valid records. */
function parseJsonl<N extends ContractName>(
  text: string,
  rel: string,
  contract: N,
  issues: IssueList,
): JsonlRecord<ContractTypes[N]>[] {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const records: JsonlRecord<ContractTypes[N]>[] = [];
  lines.forEach((raw, index) => {
    const line = index + 1;
    const content = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (content.trim() === '') {
      issues.error('INVALID_JSON', rel, '', 'blank line; every line must be one JSON record', line);
      return;
    }
    const parsed = parseJson(content);
    if (!parsed.ok) {
      issues.error('INVALID_JSON', rel, '', 'is not valid JSON', line);
      return;
    }
    const result = validateContract(contract, parsed.value);
    if (!result.ok) {
      issues.contract(rel, result.errors, line);
      return;
    }
    records.push({ line, value: result.value });
  });
  return records;
}

/** `<a>:<b>` → `<a>` (the part before the last colon). */
function idPrefix(id: string, separators = 1): string {
  let end = id.length;
  for (let i = 0; i < separators; i += 1) end = id.lastIndexOf(':', end - 1);
  return id.slice(0, end);
}

/** Walks `relDir` (a safe package path), collecting regular files. Reports anything unsafe. */
async function walkFiles(
  realRoot: string,
  relDir: string,
  out: string[],
  issues: IssueList,
): Promise<void> {
  const absDir = path.join(realRoot, ...relDir.split('/'));
  let entries;
  try {
    entries = await readdir(absDir, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    if (errorCode(error) === 'ENOTDIR') {
      issues.error('FILE_NOT_REGULAR', relDir, '', 'must be a directory');
      return;
    }
    throw error;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (isAtomicTempName(entry.name)) {
      issues.warn(
        'TEMP_LEFTOVER',
        relDir,
        '',
        'contains a temp entry left by an interrupted write; it is ignored and safe to delete',
      );
      continue;
    }
    const rel = `${relDir}/${entry.name}`;
    const unsafe = checkRelPath(rel);
    if (unsafe !== undefined) {
      issues.error(
        'UNSAFE_PATH',
        relDir,
        '',
        `contains an entry with an unsafe name: ${unsafe.message}`,
      );
      continue;
    }
    if (entry.isSymbolicLink()) {
      // Symlinks and, on Windows, junctions. Allowed only to files that stay inside the root.
      const resolved = await resolveOrReport(realRoot, rel, issues, rel, '');
      if (resolved?.real === undefined) continue;
      const info = await stat(resolved.real);
      if (info.isDirectory()) {
        issues.error(
          'UNSAFE_PATH',
          rel,
          '',
          'linked directories (symlinks, junctions) are not supported in source artifacts',
        );
      } else if (info.isFile()) {
        out.push(rel);
      } else {
        issues.error('FILE_NOT_REGULAR', rel, '', 'must be a regular file');
      }
    } else if (entry.isDirectory()) {
      await walkFiles(realRoot, rel, out, issues);
    } else if (entry.isFile()) {
      out.push(rel);
    } else {
      issues.error('FILE_NOT_REGULAR', rel, '', 'must be a regular file');
    }
  }
}

/** Source artifacts present on disk, sorted. */
async function scanSources(realRoot: string, issues: IssueList): Promise<string[]> {
  const files: string[] = [];
  await walkFiles(realRoot, AUDIO_DIR, files, issues);
  for (const rel of [FRAGMENTS_FILE, FOUNDRY_FILE]) {
    const resolved = await resolveOrReport(realRoot, rel, issues, rel, '');
    if (resolved?.exists === true) files.push(rel);
  }
  for (const group of findCaseCollisions(files)) {
    for (const rel of group) {
      issues.error(
        'CASE_COLLISION',
        rel,
        '',
        'another source file differs only in letter case; they collide on Windows',
      );
    }
  }
  return files.sort();
}

async function scanRootLeftovers(realRoot: string, issues: IssueList): Promise<void> {
  for (const entry of await readdir(realRoot, { withFileTypes: true })) {
    if (isAtomicTempName(entry.name)) {
      issues.warn(
        'TEMP_LEFTOVER',
        '.',
        '',
        'contains a temp entry left by an interrupted write; it is ignored and safe to delete',
      );
    }
  }
}

interface FragmentFacts {
  /** Audio paths referenced by valid fragment records. */
  readonly audioPaths: Set<string>;
}

function checkFragments(
  records: readonly JsonlRecord<ContractTypes['fragment']>[],
  issues: IssueList,
): FragmentFacts {
  const audioPaths = new Set<string>();
  const ids = new Set<string>();
  for (const { line, value } of records) {
    if (idPrefix(value.fragment_id) !== value.speaker_id) {
      issues.error(
        'INCONSISTENT',
        FRAGMENTS_FILE,
        '/fragment_id',
        'must start with the record speaker_id (<speaker_id>:<n>, ADR-004)',
        line,
      );
    }
    if (ids.has(value.fragment_id)) {
      issues.error('DUPLICATE', FRAGMENTS_FILE, '/fragment_id', 'is used by an earlier line', line);
    }
    ids.add(value.fragment_id);
    const unsafe = checkRelPath(value.path);
    if (unsafe !== undefined) {
      issues.error('UNSAFE_PATH', FRAGMENTS_FILE, '/path', unsafe.message, line);
      continue;
    }
    if (!value.path.startsWith(`${AUDIO_DIR}/${value.speaker_id}/`)) {
      issues.error(
        'INCONSISTENT',
        FRAGMENTS_FILE,
        '/path',
        'must be under audio/<speaker_id>/ of the same record (ADR-006 layout)',
        line,
      );
    }
    if (audioPaths.has(value.path)) {
      issues.error('DUPLICATE', FRAGMENTS_FILE, '/path', 'is used by an earlier line', line);
    }
    audioPaths.add(value.path);
  }
  for (const group of findCaseCollisions(audioPaths)) {
    for (const rel of group) {
      issues.error(
        'CASE_COLLISION',
        FRAGMENTS_FILE,
        '/path',
        `${rel} differs only in letter case from another fragment path; they collide on Windows`,
      );
    }
  }
  return { audioPaths };
}

function checkFoundry(
  records: readonly JsonlRecord<ContractTypes['foundry-event']>[],
  manifest: Manifest | undefined,
  issues: IssueList,
): void {
  const ids = new Set<string>();
  for (const { line, value } of records) {
    if (value.event_id !== `fvtt:${value.capture_id}:${value.seq}`) {
      issues.error(
        'INCONSISTENT',
        FOUNDRY_FILE,
        '/event_id',
        'must equal fvtt:<capture_id>:<seq> of the same record (ADR-004)',
        line,
      );
    }
    if (ids.has(value.event_id)) {
      issues.error('DUPLICATE', FOUNDRY_FILE, '/event_id', 'is used by an earlier line', line);
    }
    ids.add(value.event_id);
    if (manifest !== undefined) {
      for (const key of ['campaign_id', 'session_id'] as const) {
        if (value[key] !== manifest[key]) {
          issues.error(
            'INCONSISTENT',
            FOUNDRY_FILE,
            `/${key}`,
            `does not match ${key} in manifest.json`,
            line,
          );
        }
      }
    }
  }
}

async function checkSeal(
  realRoot: string,
  manifest: Manifest,
  sources: readonly string[],
  issues: IssueList,
): Promise<void> {
  const seal = manifest.seal;
  if (seal === undefined) return;
  const purged = new Map<string, string>();
  for (const [i, entry] of (manifest.purge?.purged_artifacts ?? []).entries()) {
    purged.set(entry.path, entry.hash);
    const sealed = seal.artifacts.find((a) => a.path === entry.path);
    const field = `/purge/purged_artifacts/${i}`;
    if (sealed === undefined) {
      issues.error('PURGE_MISMATCH', MANIFEST_FILE, `${field}/path`, 'is not a sealed artifact');
    } else if (sealed.kind !== 'audio-fragment') {
      issues.error(
        'PURGE_MISMATCH',
        MANIFEST_FILE,
        `${field}/path`,
        'only audio-fragment artifacts can be purged',
      );
    } else if (sealed.hash !== entry.hash) {
      issues.error(
        'PURGE_MISMATCH',
        MANIFEST_FILE,
        `${field}/hash`,
        'does not match the sealed hash',
      );
    }
  }

  const sealedPaths = new Set<string>();
  for (const [i, artifact] of seal.artifacts.entries()) {
    const field = `/seal/artifacts/${i}`;
    const unsafe = checkRelPath(artifact.path);
    if (unsafe !== undefined) {
      issues.error('UNSAFE_PATH', MANIFEST_FILE, `${field}/path`, unsafe.message);
      continue;
    }
    if (sealedPaths.has(artifact.path)) {
      issues.error('DUPLICATE', MANIFEST_FILE, `${field}/path`, 'is sealed twice');
      continue;
    }
    sealedPaths.add(artifact.path);
    const expectedKind = sourceKindOf(artifact.path);
    if (expectedKind === undefined) {
      issues.error(
        'ARTIFACT_KIND',
        MANIFEST_FILE,
        `${field}/path`,
        'is not a source artifact (audio/**, fragments.jsonl, foundry.jsonl)',
      );
    } else if (expectedKind !== artifact.kind) {
      issues.error(
        'ARTIFACT_KIND',
        MANIFEST_FILE,
        `${field}/kind`,
        `must be ${expectedKind} for this path`,
      );
    }
    const resolved = await resolveOrReport(realRoot, artifact.path, issues, artifact.path, '');
    if (resolved === undefined) continue;
    const purgedHash = purged.get(artifact.path);
    if (!resolved.exists || resolved.real === undefined) {
      if (purgedHash === undefined) {
        issues.error(
          'ARTIFACT_MISSING',
          artifact.path,
          '',
          'sealed artifact is missing and no purge provenance explains it',
        );
      }
      continue;
    }
    if (purgedHash !== undefined) {
      issues.warn(
        'PURGE_INCOMPLETE',
        artifact.path,
        '',
        'is recorded as purged but still exists; run `recap package purge-audio` again to finish',
      );
    }
    const info = await lstat(resolved.real);
    if (!info.isFile()) {
      issues.error('FILE_NOT_REGULAR', artifact.path, '', 'must be a regular file');
      continue;
    }
    let digest;
    try {
      digest = await sha256File(resolved.real);
    } catch {
      issues.error(
        'FILE_UNREADABLE',
        artifact.path,
        '',
        'cannot be read (locked or no permission)',
      );
      continue;
    }
    if (digest.bytes !== artifact.bytes) {
      issues.error(
        'ARTIFACT_MODIFIED',
        artifact.path,
        '',
        `size changed after sealing (manifest.json ${field}/bytes)`,
      );
    } else if (digest.hash !== artifact.hash) {
      issues.error(
        'ARTIFACT_MODIFIED',
        artifact.path,
        '',
        `content changed after sealing (manifest.json ${field}/hash)`,
      );
    }
  }
  for (const group of findCaseCollisions(sealedPaths)) {
    for (const rel of group) {
      issues.error(
        'CASE_COLLISION',
        MANIFEST_FILE,
        '/seal/artifacts',
        `${rel} differs only in letter case from another sealed path; they collide on Windows`,
      );
    }
  }
  for (const rel of sources) {
    if (!sealedPaths.has(rel)) {
      issues.error(
        'ARTIFACT_UNSEALED',
        rel,
        '',
        'source artifact was added after sealing; sealed packages cannot gain source artifacts',
      );
    }
  }
}

function checkFragmentAudio(
  fragments: FragmentFacts,
  manifest: Manifest | undefined,
  sources: readonly string[],
  issues: IssueList,
): void {
  const onDisk = new Set(sources);
  const purged = new Set((manifest?.purge?.purged_artifacts ?? []).map((a) => a.path));
  const sealed = new Set((manifest?.seal?.artifacts ?? []).map((a) => a.path));
  for (const rel of fragments.audioPaths) {
    if (onDisk.has(rel) || purged.has(rel)) continue;
    // A missing sealed file is already reported as ARTIFACT_MISSING.
    if (sealed.has(rel)) continue;
    issues.error('FRAGMENT_AUDIO_MISSING', FRAGMENTS_FILE, '/path', `${rel} does not exist`);
  }
  for (const rel of sources) {
    if (sourceKindOf(rel) === 'audio-fragment' && !fragments.audioPaths.has(rel)) {
      issues.warn(
        'AUDIO_UNREFERENCED',
        rel,
        '',
        'no record in fragments.jsonl refers to this file',
      );
    }
  }
}

interface RunDirSpec<N extends ContractName> {
  readonly base: string;
  readonly namePattern: RegExp;
  readonly nameRule: string;
  readonly file: string;
  readonly contract: N;
  readonly jsonl: boolean;
  readonly check: (
    record: ContractTypes[N],
    dirName: string,
    report: (field: string, message: string) => void,
  ) => void;
  readonly idOf?: (record: ContractTypes[N]) => string;
  readonly idField?: string;
}

async function checkRunDirs<N extends ContractName>(
  realRoot: string,
  spec: RunDirSpec<N>,
  issues: IssueList,
): Promise<void> {
  const base = await resolveOrReport(realRoot, spec.base, issues, spec.base, '');
  if (base?.real === undefined) return;
  if (!(await stat(base.real)).isDirectory()) {
    issues.error('FILE_NOT_REGULAR', spec.base, '', 'must be a directory');
    return;
  }
  const entries = await readdir(base.real, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (isAtomicTempName(entry.name)) {
      issues.warn(
        'TEMP_LEFTOVER',
        spec.base,
        '',
        'contains an unfinished run (interrupted before finalization); it is ignored and safe to delete',
      );
      continue;
    }
    if (!spec.namePattern.test(entry.name)) {
      issues.error('UNSAFE_PATH', spec.base, '', `contains an entry that is not ${spec.nameRule}`);
      continue;
    }
    const rel = `${spec.base}/${entry.name}/${spec.file}`;
    const text = await readPackageText(realRoot, rel, issues);
    if (text === MISSING) {
      issues.error('FILE_MISSING', rel, '', 'finalized run directory has no output file');
      continue;
    }
    if (text === undefined) continue;
    const records: JsonlRecord<ContractTypes[N]>[] = [];
    if (spec.jsonl) {
      records.push(...parseJsonl(text, rel, spec.contract, issues));
    } else {
      const parsed = parseJson(text);
      if (!parsed.ok) {
        issues.error('INVALID_JSON', rel, '', 'is not valid JSON');
        continue;
      }
      const result = validateContract(spec.contract, parsed.value);
      if (!result.ok) {
        issues.contract(rel, result.errors);
        continue;
      }
      records.push({ line: 0, value: result.value });
    }
    const seen = new Set<string>();
    for (const { line, value } of records) {
      const lineNo = spec.jsonl ? line : undefined;
      spec.check(value, entry.name, (field, message) => {
        issues.error('INCONSISTENT', rel, field, message, lineNo);
      });
      if (spec.idOf !== undefined && spec.idField !== undefined) {
        const id = spec.idOf(value);
        if (seen.has(id)) {
          issues.error('DUPLICATE', rel, spec.idField, 'is used by an earlier line', lineNo);
        }
        seen.add(id);
      }
    }
  }
}

async function checkDerived(realRoot: string, issues: IssueList): Promise<void> {
  await checkRunDirs(
    realRoot,
    {
      base: 'transcript',
      namePattern: ULID,
      nameRule: 'a transcription run ID (ULID)',
      file: 'segments.jsonl',
      contract: 'transcription-segment',
      jsonl: true,
      check: (record, dir, report) => {
        if (record.transcription_run_id !== dir) {
          report('/transcription_run_id', 'does not match the run directory name');
        }
        if (idPrefix(record.segment_id, 2) !== record.transcription_run_id) {
          report('/segment_id', 'must start with the record transcription_run_id (ADR-004)');
        }
      },
      idOf: (record) => record.segment_id,
      idField: '/segment_id',
    },
    issues,
  );
  await checkRunDirs(
    realRoot,
    {
      base: 'classify',
      namePattern: ULID,
      nameRule: 'a classification run ID (ULID)',
      file: 'results.jsonl',
      contract: 'classification-result',
      jsonl: true,
      check: (record, dir, report) => {
        if (record.classification_run_id !== dir) {
          report('/classification_run_id', 'does not match the run directory name');
        }
        if (idPrefix(record.segment_id, 2) !== record.transcription_run_id) {
          report('/segment_id', 'must start with the record transcription_run_id (ADR-004)');
        }
      },
      idOf: (record) => record.segment_id,
      idField: '/segment_id',
    },
    issues,
  );
  await checkRunDirs(
    realRoot,
    {
      base: 'recap',
      namePattern: REVISION,
      nameRule: 'a recap revision (positive integer)',
      file: 'recap.json',
      contract: 'recap',
      jsonl: false,
      check: (record, dir, report) => {
        if (String(record.recap_revision) !== dir) {
          report('/recap_revision', 'does not match the revision directory name');
        }
      },
    },
    issues,
  );
}

function verdict(
  issues: readonly PackageIssue[],
  lifecycle: LifecycleState | undefined,
): PackageState {
  const errors = issues.filter((i) => i.severity === 'error');
  if (errors.length === 0 && lifecycle !== undefined) return lifecycle;
  if (errors.some((i) => INTEGRITY_CODES.has(i.code))) return 'corrupt';
  return 'invalid';
}

/** Validates the session package at `root` (the package directory). Never throws on bad data. */
export async function validatePackage(root: string): Promise<PackageReport> {
  const issues = new IssueList();
  let realRoot: string;
  try {
    realRoot = await realPackageRoot(root);
    if (!(await stat(realRoot)).isDirectory()) throw new Error('not a directory');
  } catch {
    issues.error(
      'PACKAGE_NOT_FOUND',
      '.',
      '',
      'package directory does not exist or is not a directory',
    );
    return {
      root,
      state: 'invalid',
      ok: false,
      lifecycle: undefined,
      issues: issues.items,
      manifest: undefined,
      sources: [],
    };
  }

  let manifest: Manifest | undefined;
  const manifestText = await readPackageText(realRoot, MANIFEST_FILE, issues);
  if (manifestText === MISSING) {
    issues.error('FILE_MISSING', MANIFEST_FILE, '', 'is required in every package');
  } else if (manifestText !== undefined) {
    const parsed = parseJson(manifestText);
    if (!parsed.ok) {
      issues.error('INVALID_JSON', MANIFEST_FILE, '', 'is not valid JSON');
    } else {
      const result = validateContract('manifest', parsed.value);
      if (result.ok) manifest = result.value;
      else issues.contract(MANIFEST_FILE, result.errors);
    }
  }

  await scanRootLeftovers(realRoot, issues);
  const sources = await scanSources(realRoot, issues);

  let fragments: FragmentFacts = { audioPaths: new Set() };
  const fragmentsText = await readPackageText(realRoot, FRAGMENTS_FILE, issues);
  if (typeof fragmentsText === 'string') {
    fragments = checkFragments(
      parseJsonl(fragmentsText, FRAGMENTS_FILE, 'fragment', issues),
      issues,
    );
  }
  const foundryText = await readPackageText(realRoot, FOUNDRY_FILE, issues);
  if (typeof foundryText === 'string') {
    checkFoundry(parseJsonl(foundryText, FOUNDRY_FILE, 'foundry-event', issues), manifest, issues);
  }

  if (manifest !== undefined) await checkSeal(realRoot, manifest, sources, issues);
  checkFragmentAudio(fragments, manifest, sources, issues);
  await checkDerived(realRoot, issues);

  const lifecycle = manifest?.lifecycle;
  const state = verdict(issues.items, lifecycle);
  return {
    root,
    state,
    ok: !issues.items.some((i) => i.severity === 'error'),
    lifecycle,
    issues: issues.items,
    manifest,
    sources,
  };
}
