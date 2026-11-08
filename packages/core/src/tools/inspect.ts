/**
 * Hash-checks the whisper.cpp binary and model against the lock (T23) and exposes the result as job
 * inputs. Read-only. The whole binary set is checked, not just the executable: `whisper-cli.exe` is a
 * thin launcher and the code that transcribes is in `whisper.dll` and the `ggml*.dll` files.
 *
 * A file at the locked location that fails its hash is an error (it was corrupted or replaced). A
 * file the operator named in overrides.yaml is hashed too, but a mismatch is only a warning: the
 * operator chose it. Either way the job inputs carry the hash of what is really on disk.
 */
import path from 'node:path';
import type { ToolsLock } from '@sargas-recap/contracts';
import { modelInput, type JobInput } from '../jobs/index.ts';
import { sha256Bytes, sha256File } from '../package/hash.ts';
import type { DataPaths } from '../paths/index.ts';
import { ToolsError } from './errors.ts';
import { activeModel, loadToolsLock } from './lock.ts';
import { loadWhisperOverrides, type ResolvedOverrides } from './overrides.ts';

export type FileState = 'ok' | 'missing' | 'mismatch' | 'unreadable';

export interface FileCheck {
  /** Base name, the stable identity of the file across install locations. */
  readonly name: string;
  readonly path: string;
  readonly state: FileState;
  readonly expected: string;
  /** `sha256:<hex>` of what is on disk; undefined when it could not be read. */
  readonly actual: string | undefined;
}

export type ItemState =
  | 'ok'
  /** An override differs from the lock: usable, with a warning. */
  | 'override-mismatch'
  | 'missing'
  | 'mismatch'
  | 'unreadable'
  /** The lock pins no binary for this OS and there is no override. */
  | 'unsupported-platform';

export type ItemSource = 'lock' | 'override';

export interface BinaryCheck {
  readonly source: ItemSource;
  readonly state: ItemState;
  readonly executable: string | undefined;
  readonly files: readonly FileCheck[];
  /** Digest over the hash of every file present; undefined when none could be read. */
  readonly hash: string | undefined;
}

export interface ModelCheck {
  readonly source: ItemSource;
  readonly state: ItemState;
  /** Lock model ID, or `override`. */
  readonly id: string;
  readonly path: string;
  readonly file: FileCheck;
}

export interface WhisperInspection {
  readonly lock: ToolsLock;
  readonly binary: BinaryCheck;
  readonly model: ModelCheck;
  readonly warnings: readonly string[];
}

export interface InspectOptions {
  /** Defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform | undefined;
  /** Defaults to `process.arch`. */
  readonly arch?: string | undefined;
}

async function checkFile(file: string, expected: string, name: string): Promise<FileCheck> {
  try {
    const { hash } = await sha256File(file);
    return {
      name,
      path: file,
      state: hash === expected ? 'ok' : 'mismatch',
      expected,
      actual: hash,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const state = code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unreadable';
    return { name, path: file, state, expected, actual: undefined };
  }
}

/** Order-independent digest of a set of files, so a change to any DLL changes the job input. */
function combinedHash(files: readonly FileCheck[]): string | undefined {
  const lines = files.flatMap((f) => (f.actual === undefined ? [] : [`${f.name}\t${f.actual}`]));
  return lines.length === 0 ? undefined : sha256Bytes(lines.sort().join('\n'));
}

function worstLockState(files: readonly FileCheck[]): ItemState {
  // Tampering outranks absence: a mismatch must not read as "just not installed".
  for (const state of ['mismatch', 'unreadable', 'missing'] as const) {
    if (files.some((f) => f.state === state)) return state;
  }
  return 'ok';
}

async function inspectBinary(
  lock: ToolsLock,
  paths: DataPaths,
  overridePath: string | undefined,
  options: InspectOptions,
): Promise<BinaryCheck> {
  const { binary } = lock.whisper;
  const baseName = (rel: string): string => path.posix.basename(rel);

  if (overridePath !== undefined) {
    const dir = path.dirname(overridePath);
    const files = await Promise.all(
      binary.files.map((f) =>
        checkFile(
          f.path === binary.executable ? overridePath : path.join(dir, baseName(f.path)),
          f.sha256,
          baseName(f.path),
        ),
      ),
    );
    const exe = files.find((f) => f.name === baseName(binary.executable));
    const state: ItemState =
      exe?.state === 'missing' || exe?.state === 'unreadable'
        ? exe.state
        : files.every((f) => f.state === 'ok')
          ? 'ok'
          : 'override-mismatch';
    return {
      source: 'override',
      state,
      executable: overridePath,
      files,
      hash: combinedHash(files),
    };
  }

  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if (binary.platform !== `${platform}-${arch}`) {
    return {
      source: 'lock',
      state: 'unsupported-platform',
      executable: undefined,
      files: [],
      hash: undefined,
    };
  }
  const dir = paths.whisperBuildDir(binary.install_dir);
  const files = await Promise.all(
    binary.files.map((f) =>
      checkFile(path.join(dir, ...f.path.split('/')), f.sha256, baseName(f.path)),
    ),
  );
  return {
    source: 'lock',
    state: worstLockState(files),
    executable: path.join(dir, ...binary.executable.split('/')),
    files,
    hash: combinedHash(files),
  };
}

async function inspectModel(
  lock: ToolsLock,
  paths: DataPaths,
  overridePath: string | undefined,
): Promise<ModelCheck> {
  const model = activeModel(lock);
  if (overridePath !== undefined) {
    const file = await checkFile(overridePath, model.sha256, path.basename(overridePath));
    const state: ItemState =
      file.state === 'ok'
        ? 'ok'
        : file.state === 'mismatch'
          ? 'override-mismatch'
          : file.state === 'missing'
            ? 'missing'
            : 'unreadable';
    return {
      source: 'override',
      state,
      id: file.state === 'ok' ? model.id : 'override',
      path: overridePath,
      file,
    };
  }
  const location = paths.whisperModelFile(model.file);
  const file = await checkFile(location, model.sha256, model.file);
  return { source: 'lock', state: file.state, id: model.id, path: location, file };
}

function overrideWarnings(binary: BinaryCheck, model: ModelCheck): string[] {
  const warnings: string[] = [];
  if (binary.state === 'override-mismatch') {
    const bad = binary.files
      .filter((f) => f.state !== 'ok')
      .map((f) => `${f.name} (${f.state})`)
      .join(', ');
    warnings.push(`whisper binary override does not match the lock: ${bad}`);
  }
  if (model.state === 'override-mismatch') {
    warnings.push('whisper model override does not match the hash of the active model in the lock');
  }
  return warnings;
}

/** Checks the installed binary and model. Hashes the model: expect a second or two for 1.6 GB. */
export async function inspectWhisper(
  lock: ToolsLock,
  paths: DataPaths,
  overrides: ResolvedOverrides = {},
  options: InspectOptions = {},
): Promise<WhisperInspection> {
  const [binary, model] = await Promise.all([
    inspectBinary(lock, paths, overrides.binaryPath, options),
    inspectModel(lock, paths, overrides.modelPath),
  ]);
  return { lock, binary, model, warnings: overrideWarnings(binary, model) };
}

export function isUsable(state: ItemState): boolean {
  return state === 'ok' || state === 'override-mismatch';
}

export interface WhisperTools {
  readonly version: string;
  readonly commit: string;
  readonly binaryPath: string;
  readonly binaryHash: string;
  readonly modelId: string;
  readonly modelPath: string;
  readonly modelHash: string;
  readonly warnings: readonly string[];
}

export interface ResolveWhisperOptions extends InspectOptions {
  readonly paths: DataPaths;
  /** Defaults to the committed lock. */
  readonly lock?: ToolsLock | undefined;
  /** Defaults to `paths.whisperOverridesFile`. */
  readonly overrides?: ResolvedOverrides | undefined;
}

function refuse(what: string, state: ItemState): ToolsError {
  const tampered = state === 'mismatch' || state === 'unreadable';
  return new ToolsError(
    tampered ? 'TOOLS_TAMPERED' : 'TOOLS_NOT_PROVISIONED',
    `whisper ${what}: ${state}`,
    tampered
      ? `the ${what} does not match tools.lock.json; run \`recap setup whisper\` to replace it`
      : 'run `recap setup whisper`; see docs/setup-windows.md',
  );
}

/**
 * The verified binary and model for a run (T09). Refuses anything missing or tampered with; an
 * override that differs from the lock is allowed and listed in `warnings`.
 */
export async function resolveWhisperTools(options: ResolveWhisperOptions): Promise<WhisperTools> {
  const lock = options.lock ?? (await loadToolsLock());
  const overrides =
    options.overrides ?? (await loadWhisperOverrides(options.paths.whisperOverridesFile));
  const { binary, model, warnings } = await inspectWhisper(lock, options.paths, overrides, options);
  if (!isUsable(binary.state) || binary.executable === undefined || binary.hash === undefined) {
    throw refuse('binary', binary.state);
  }
  if (!isUsable(model.state) || model.file.actual === undefined) {
    throw refuse('model', model.state);
  }
  return {
    version: lock.whisper.version,
    commit: lock.whisper.commit,
    binaryPath: binary.executable,
    binaryHash: binary.hash,
    modelId: model.id,
    modelPath: model.path,
    modelHash: model.file.actual,
    warnings,
  };
}

/** The verified binary and model as T07 dependency inputs, so changing either reruns transcription. */
export function whisperJobInputs(
  tools: Pick<WhisperTools, 'modelId' | 'modelHash' | 'binaryHash'>,
): JobInput[] {
  return [
    modelInput(`whisper-model/${tools.modelId}`, tools.modelHash),
    modelInput('whisper-binary', tools.binaryHash),
  ];
}
