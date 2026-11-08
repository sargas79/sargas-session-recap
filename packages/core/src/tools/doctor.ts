/**
 * `recap doctor` lines for whisper.cpp (T23): binary and model presence, hash status, Vulkan.
 * Read-only and never throws.
 *
 * Not installed yet is reported but is not a failure of `--strict` (CI and fresh machines have no
 * whisper, and only transcription needs it). A file that fails its hash, an invalid lock or an
 * override pointing at nothing does fail it.
 */
import { createDataPaths } from '../paths/index.ts';
import { ToolsError } from './errors.ts';
import {
  inspectWhisper,
  type InspectOptions,
  type ItemState,
  type WhisperInspection,
} from './inspect.ts';
import { defaultToolsLockFile, loadToolsLock } from './lock.ts';
import { loadWhisperOverrides } from './overrides.ts';
import { probeVulkan, type VulkanProbe, type VulkanStatus } from './vulkan.ts';

export interface WhisperCheckOptions extends InspectOptions {
  readonly lockFile?: string | undefined;
  readonly vulkan?: VulkanProbe | undefined;
}

export interface WhisperCheck {
  /** False when a check found something wrong, as opposed to not installed yet. */
  readonly ok: boolean;
  readonly lines: string[];
  readonly inspection: WhisperInspection | undefined;
  readonly vulkan: VulkanStatus;
}

const label = (name: string): string => `  ${name}:`.padEnd(12);
const indent = ' '.repeat(12);
const SETUP_FIX = 'run `recap setup whisper` (see docs/setup-windows.md)';

/** Whether this state should fail `recap doctor --strict`. */
function failsStrict(state: ItemState, source: 'lock' | 'override'): boolean {
  switch (state) {
    case 'ok':
    case 'override-mismatch':
    case 'unsupported-platform':
      return false;
    case 'missing':
      return source === 'override';
    case 'mismatch':
    case 'unreadable':
      return true;
  }
}

function stateLine(name: string, state: ItemState, detail: string): string {
  const status: Record<ItemState, string> = {
    ok: 'ok',
    'override-mismatch': 'ok (differs from the lock)',
    missing: 'MISSING',
    mismatch: 'HASH MISMATCH',
    unreadable: 'UNREADABLE',
    'unsupported-platform': 'not pinned for this platform',
  };
  return `${label(name)}${status[state]}${detail === '' ? '' : ` ${detail}`}`;
}

function inspectionLines({ lock, binary, model, warnings }: WhisperInspection): string[] {
  const { version, commit, binary: pin } = lock.whisper;
  const lines = [stateLine('whisper', binary.state, `${version} (${commit.slice(0, 7)})`)];
  if (binary.executable !== undefined) {
    lines.push(`${indent}path: ${binary.executable} (from ${binary.source})`);
  }
  if (binary.state === 'ok') {
    lines.push(`${indent}sha256: ${String(binary.files.length)} files verified`);
  } else if (binary.state === 'unsupported-platform') {
    lines.push(`${indent}note: the lock pins a ${pin.platform} binary; use overrides.yaml here`);
  } else {
    for (const file of binary.files.filter((f) => f.state !== 'ok')) {
      lines.push(`${indent}${file.name}: ${file.state}`);
    }
    if (binary.source === 'lock') {
      lines.push(`${indent}fix: ${SETUP_FIX}`);
    }
  }

  lines.push(stateLine('model', model.state, model.id));
  lines.push(`${indent}path: ${model.path} (from ${model.source})`);
  if (model.state === 'ok') {
    lines.push(`${indent}sha256: verified`);
  } else if (model.source === 'lock') {
    lines.push(`${indent}fix: ${SETUP_FIX}`);
  }
  for (const warning of warnings) lines.push(`${indent}warning: ${warning}`);
  return lines;
}

function vulkanLines(status: VulkanStatus): string[] {
  switch (status.state) {
    case 'found':
      return [
        `${label('vulkan')}ok ${status.devices.map((d) => `${d.name} (${d.type})`).join(', ')}`,
      ];
    case 'no-gpu':
      return [
        `${label('vulkan')}NO GPU detected`,
        `${indent}note: whisper.cpp would fall back to the CPU, which is far slower`,
      ];
    case 'unknown':
      return [`${label('vulkan')}unknown (${status.reason})`];
  }
}

/** Runs the whisper checks. `root` is the resolved data root, or undefined if unusable. */
export async function checkWhisper(
  root: string | undefined,
  options: WhisperCheckOptions = {},
): Promise<WhisperCheck> {
  const vulkan = await (options.vulkan ?? probeVulkan)();
  if (root === undefined) {
    return {
      ok: true,
      lines: [`${label('whisper')}not checked (no usable data root)`, ...vulkanLines(vulkan)],
      inspection: undefined,
      vulkan,
    };
  }
  try {
    const paths = createDataPaths(root);
    const lock = await loadToolsLock(options.lockFile ?? defaultToolsLockFile());
    const overrides = await loadWhisperOverrides(paths.whisperOverridesFile);
    const inspection = await inspectWhisper(lock, paths, overrides, options);
    const ok =
      !failsStrict(inspection.binary.state, inspection.binary.source) &&
      !failsStrict(inspection.model.state, inspection.model.source);
    return {
      ok,
      lines: [...inspectionLines(inspection), ...vulkanLines(vulkan)],
      inspection,
      vulkan,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof ToolsError ? ` [${error.code}]` : '';
    return {
      ok: false,
      lines: [`${label('whisper')}UNUSABLE - ${message}${code}`, ...vulkanLines(vulkan)],
      inspection: undefined,
      vulkan,
    };
  }
}
