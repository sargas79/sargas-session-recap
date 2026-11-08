/**
 * Lifecycle transitions that rewrite the manifest (ADR-006): `seal` and `purge-audio`.
 *
 * Both validate the package first and refuse to act on an invalid one, write the new manifest with
 * the atomic helper, and validate again afterwards, so they either leave a package that validates
 * in the new state or report why not.
 */
import { readdir, rm, rmdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateContract, type Manifest } from '@sargas-recap/contracts';
import type { Logger } from '../log/index.ts';
import { writeFileAtomic, type AtomicOptions } from './atomic.ts';
import { sha256File } from './hash.ts';
import { PackageError, type PackageIssue } from './issues.ts';
import { realPackageRoot, resolveInsidePackage } from './safe-path.ts';
import {
  AUDIO_DIR,
  FRAGMENTS_FILE,
  MANIFEST_FILE,
  sourceKindOf,
  validatePackage,
  type PackageReport,
} from './validate.ts';

/** Serialized manifest: two-space JSON with a final newline (stable diffs). */
export function serializeManifest(manifest: Manifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** Validates `manifest` against its contract and writes it atomically to `<root>/manifest.json`. */
export async function writeManifest(
  root: string,
  manifest: Manifest,
  options: AtomicOptions = {},
): Promise<void> {
  const result = validateContract('manifest', manifest);
  if (!result.ok) {
    throw new PackageError(
      'MANIFEST_INVALID',
      'refusing to write a manifest that fails its contract',
      result.errors.map((e) => ({
        severity: 'error',
        code: 'CONTRACT',
        file: MANIFEST_FILE,
        field: e.path,
        message: e.message,
      })),
    );
  }
  const realRoot = await realPackageRoot(root);
  const target = await resolveInsidePackage(realRoot, MANIFEST_FILE);
  await writeFileAtomic(target.absolute, serializeManifest(manifest), options);
}

function errorsOf(report: PackageReport): PackageIssue[] {
  return report.issues.filter((i) => i.severity === 'error');
}

function requireValid(report: PackageReport, action: string): Manifest {
  const manifest = report.manifest;
  if (!report.ok || manifest === undefined) {
    throw new PackageError(
      'PACKAGE_INVALID',
      `cannot ${action}: the package does not validate (${report.state}); fix the errors first`,
      errorsOf(report),
    );
  }
  return manifest;
}

export interface SealOptions extends AtomicOptions {
  /** Clock override for tests. */
  readonly now?: (() => Date) | undefined;
  readonly logger?: Logger | undefined;
}

export interface SealResult {
  readonly report: PackageReport;
  readonly artifacts: number;
  readonly bytes: number;
}

/**
 * `recap package seal`: hashes every source artifact (`audio/**`, `fragments.jsonl`,
 * `foundry.jsonl`), records them in `seal.artifacts` with `sealed_at`, and moves the lifecycle from
 * `capturing` to `sealed` (ADR-006).
 */
export async function sealPackage(root: string, options: SealOptions = {}): Promise<SealResult> {
  const before = await validatePackage(root);
  const manifest = requireValid(before, 'seal');
  if (manifest.lifecycle !== 'capturing') {
    throw new PackageError(
      'ALREADY_SEALED',
      `cannot seal: the package is already ${manifest.lifecycle}; a seal is written once`,
    );
  }
  if (!before.sources.includes(FRAGMENTS_FILE)) {
    throw new PackageError('NOTHING_TO_SEAL', 'cannot seal: fragments.jsonl is missing', [
      {
        severity: 'error',
        code: 'FILE_MISSING',
        file: FRAGMENTS_FILE,
        field: '',
        message: 'is required before sealing',
      },
    ]);
  }
  const realRoot = await realPackageRoot(root);
  const artifacts: NonNullable<Manifest['seal']>['artifacts'] = [];
  let bytes = 0;
  for (const rel of before.sources) {
    const kind = sourceKindOf(rel);
    if (kind === undefined) continue;
    const resolved = await resolveInsidePackage(realRoot, rel);
    if (resolved.real === undefined) {
      throw new PackageError('SOURCE_VANISHED', 'a source artifact disappeared while sealing', [
        { severity: 'error', code: 'FILE_MISSING', file: rel, field: '', message: 'vanished' },
      ]);
    }
    const digest = await sha256File(resolved.real);
    artifacts.push({ path: rel, kind, hash: digest.hash, bytes: digest.bytes });
    bytes += digest.bytes;
  }
  const now = options.now ?? (() => new Date());
  const sealed: Manifest = {
    ...manifest,
    lifecycle: 'sealed',
    seal: { sealed_at: now().toISOString(), artifacts },
  };
  await writeManifest(root, sealed, options);
  const after = await validatePackage(root);
  if (!after.ok) {
    throw new PackageError(
      'SEAL_VERIFY_FAILED',
      'the package was sealed but does not validate; a source artifact changed while sealing',
      errorsOf(after),
    );
  }
  options.logger?.info('package.sealed', { command: 'package seal', count: artifacts.length });
  return { report: after, artifacts: artifacts.length, bytes };
}

export const PURGE_REASONS = ['retention-policy', 'operator-request', 'consent-withdrawn'] as const;
export type PurgeReason = (typeof PURGE_REASONS)[number];

export interface PurgePlanEntry {
  readonly path: string;
  readonly hash: string;
  readonly bytes: number;
}

export interface PurgePlan {
  readonly report: PackageReport;
  /** Audio files that will be deleted. */
  readonly files: readonly PurgePlanEntry[];
  readonly bytes: number;
  /** True when a purge is already recorded and only leftover files remain to delete. */
  readonly resume: boolean;
}

const PURGEABLE = new Set(['sealed', 'processing', 'retained', 'audio-purged']);

/**
 * Works out what `purge-audio` would delete, without changing anything. Used by the CLI to show
 * the operator what they are confirming.
 */
export async function planAudioPurge(root: string): Promise<PurgePlan> {
  const report = await validatePackage(root);
  const resumable =
    report.manifest?.lifecycle === 'audio-purged' &&
    errorsOf(report).length === 0 &&
    report.issues.some((i) => i.code === 'PURGE_INCOMPLETE');
  const manifest = requireValid(report, 'purge audio');
  if (!PURGEABLE.has(manifest.lifecycle)) {
    throw new PackageError(
      'NOT_SEALED',
      'cannot purge audio: the package is not sealed yet; run `recap package seal` first',
    );
  }
  const seal = manifest.seal;
  if (seal === undefined) throw new PackageError('NOT_SEALED', 'cannot purge audio: no seal');
  const onDisk = new Set(report.sources);
  if (manifest.lifecycle === 'audio-purged') {
    const files = (manifest.purge?.purged_artifacts ?? [])
      .filter((entry) => onDisk.has(entry.path))
      .map((entry) => ({
        path: entry.path,
        hash: entry.hash,
        bytes: seal.artifacts.find((a) => a.path === entry.path)?.bytes ?? 0,
      }));
    if (!resumable || files.length === 0) {
      throw new PackageError('ALREADY_PURGED', 'audio was already purged from this package');
    }
    return { report, files, bytes: files.reduce((n, f) => n + f.bytes, 0), resume: true };
  }
  const files = seal.artifacts
    .filter((a) => a.kind === 'audio-fragment')
    .map((a) => ({ path: a.path, hash: a.hash, bytes: a.bytes }));
  if (files.length === 0) {
    throw new PackageError('NOTHING_TO_PURGE', 'the seal lists no audio; nothing to purge');
  }
  return { report, files, bytes: files.reduce((n, f) => n + f.bytes, 0), resume: false };
}

export interface PurgeOptions extends AtomicOptions {
  /** Operator label recorded as `purge.purged_by` (1-64 chars). Defaults to the OS user name. */
  readonly purgedBy?: string | undefined;
  readonly reason?: PurgeReason | undefined;
  readonly now?: (() => Date) | undefined;
  readonly logger?: Logger | undefined;
}

export interface PurgeResult {
  readonly report: PackageReport;
  readonly deleted: number;
  readonly bytes: number;
}

/** OS user name as an operator label, or `operator` when it cannot be read. */
export function defaultOperatorLabel(): string {
  try {
    const name = os.userInfo().username.trim();
    return name.length > 0 ? name.slice(0, 64) : 'operator';
  } catch {
    return 'operator';
  }
}

async function removeEmptyDirs(dir: string, keep: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) await removeEmptyDirs(path.join(dir, entry.name), keep);
  }
  if (dir === keep) return;
  await rmdir(dir).catch(() => undefined); // ENOTEMPTY and friends: leave it
}

/**
 * `recap package purge-audio`: deletes every sealed audio file and records purge provenance
 * (`purged_at`, `purged_by`, `reason`, `purged_artifacts[] = {path, hash}`), moving the lifecycle
 * to `audio-purged` (ADR-006). Confirmation is the caller's job (the CLI asks or requires `--yes`).
 *
 * Crash safety: the provenance is written (atomically) BEFORE any file is deleted. A crash after
 * that leaves a package that validates as `audio-purged` with a PURGE_INCOMPLETE warning, and
 * running the command again finishes the deletion. Deleting first would leave missing audio with
 * no provenance, which is indistinguishable from corruption.
 */
export async function purgeAudio(root: string, options: PurgeOptions = {}): Promise<PurgeResult> {
  const plan = await planAudioPurge(root);
  const manifest = plan.report.manifest;
  if (manifest === undefined) throw new PackageError('PACKAGE_INVALID', 'manifest is invalid');
  const purgedBy = (options.purgedBy ?? defaultOperatorLabel()).trim();
  if (purgedBy.length === 0 || purgedBy.length > 64) {
    throw new PackageError('INVALID_ARGUMENT', 'the operator label must be 1 to 64 characters');
  }
  if (!plan.resume) {
    const now = options.now ?? (() => new Date());
    const purged: Manifest = {
      ...manifest,
      lifecycle: 'audio-purged',
      purge: {
        purged_at: now().toISOString(),
        purged_by: purgedBy,
        reason: options.reason ?? 'operator-request',
        purged_artifacts: plan.files.map((f) => ({ path: f.path, hash: f.hash })),
      },
    };
    await writeManifest(root, purged, options);
  }

  const realRoot = await realPackageRoot(root);
  let deleted = 0;
  for (const file of plan.files) {
    const resolved = await resolveInsidePackage(realRoot, file.path);
    if (!resolved.exists) continue;
    await rm(resolved.absolute, { force: true, maxRetries: 5, retryDelay: 100 });
    deleted += 1;
  }
  const audioRoot = path.join(realRoot, AUDIO_DIR);
  await removeEmptyDirs(audioRoot, realRoot);

  const after = await validatePackage(root);
  if (after.state !== 'audio-purged') {
    throw new PackageError(
      'PURGE_VERIFY_FAILED',
      `audio was deleted but the package validates as ${after.state}`,
      errorsOf(after),
    );
  }
  options.logger?.info('package.audio-purged', {
    command: 'package purge-audio',
    count: deleted,
    status: after.state,
  });
  return { report: after, deleted, bytes: plan.bytes };
}
