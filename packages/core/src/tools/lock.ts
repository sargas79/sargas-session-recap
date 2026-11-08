/**
 * Loads `tools.lock.json` (T23): the contract schema, then the rules JSON Schema cannot express.
 * The lock lives next to the core package (like `prompts/`), so the path resolves from both
 * `src/tools/` and `dist/tools/`.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateContract, type ToolsLock, type WhisperModelLock } from '@sargas-recap/contracts';
import { checkRelPath, findCaseCollisions, isReservedWindowsName } from '../package/safe-path.ts';
import { ToolsError } from './errors.ts';

export function defaultToolsLockFile(): string {
  return fileURLToPath(new URL('../../tools.lock.json', import.meta.url));
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Only https, or http to this machine (test servers). URLs with credentials are refused. */
export function isAllowedDownloadUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.username !== '' || url.password !== '') return false;
  return (
    url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))
  );
}

function semanticProblems(lock: ToolsLock): string[] {
  const problems: string[] = [];
  const { binary, models, active_model: active } = lock.whisper;

  const paths = binary.files.map((f) => f.path);
  for (const rel of paths) {
    const problem = checkRelPath(rel);
    if (problem !== undefined) problems.push(`binary file path: ${problem.message}`);
  }
  if (findCaseCollisions(paths).length > 0 || new Set(paths).size !== paths.length) {
    problems.push('binary files are listed twice or differ only by case');
  }
  // Job inputs and overrides identify a file by its base name.
  const baseNames = paths.map((rel) => path.posix.basename(rel).toLowerCase());
  if (new Set(baseNames).size !== baseNames.length) {
    problems.push('binary files must have distinct base names');
  }
  if (!paths.includes(binary.executable)) {
    problems.push('binary executable is not one of its files');
  }
  if (isReservedWindowsName(binary.install_dir)) {
    problems.push('binary install_dir is a reserved Windows name');
  }

  const ids = models.map((m) => m.id);
  if (new Set(ids).size !== ids.length) problems.push('model ids must be unique');
  const files = models.map((m) => m.file.toLowerCase());
  if (new Set(files).size !== files.length) problems.push('model files must be unique');
  for (const model of models) {
    if (isReservedWindowsName(model.file)) {
      problems.push(`model ${model.id}: file is a reserved Windows name`);
    }
    if (!isAllowedDownloadUrl(model.url)) {
      problems.push(`model ${model.id}: url must be https`);
    }
  }
  if (!ids.includes(active)) problems.push('active_model is not one of the models');

  if (binary.source === 'archive' && !isAllowedDownloadUrl(binary.archive.url)) {
    problems.push('binary archive url must be https');
  }
  return problems;
}

/** Validates lock text. `file` labels errors. Throws `TOOLS_LOCK_INVALID`. */
export function parseToolsLock(text: string, file: string): ToolsLock {
  const fail = (detail: string, cause?: unknown): ToolsError =>
    new ToolsError(
      'TOOLS_LOCK_INVALID',
      `${file}: ${detail}`,
      'fix tools.lock.json; see docs/setup-windows.md',
      cause,
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (cause) {
    throw fail('not valid JSON', cause);
  }
  const result = validateContract('tools-lock', parsed);
  if (!result.ok) {
    throw fail(result.errors.map((e) => `${e.path} ${e.message}`).join('; '));
  }
  const problems = semanticProblems(result.value);
  if (problems.length > 0) throw fail(problems.join('; '));
  return result.value;
}

export async function loadToolsLock(file: string = defaultToolsLockFile()): Promise<ToolsLock> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (cause) {
    throw new ToolsError(
      'TOOLS_LOCK_INVALID',
      `cannot read the tools lock at ${file}`,
      undefined,
      cause,
    );
  }
  return parseToolsLock(text, file);
}

/** The model the lock selects. A loaded lock always has one (`semanticProblems`). */
export function activeModel(lock: ToolsLock): WhisperModelLock {
  const model = lock.whisper.models.find((m) => m.id === lock.whisper.active_model);
  if (model === undefined) {
    throw new ToolsError('TOOLS_LOCK_INVALID', 'active_model is not one of the models');
  }
  return model;
}
