/**
 * Operator-supplied whisper.cpp paths, for this machine only (T23):
 * `<data-root>/tools/whisper/overrides.yaml`. Not in campaign.yaml: a binary path belongs to the
 * PC, not the campaign, and `recap doctor` runs without a campaign.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { validateContract } from '@sargas-recap/contracts';
import { parseYaml } from '../config/yaml.ts';
import { ToolsError } from './errors.ts';

export interface ResolvedOverrides {
  /** Absolute path of the whisper-cli binary. */
  readonly binaryPath?: string | undefined;
  /** Absolute path of the ggml model. */
  readonly modelPath?: string | undefined;
}

/** Reads the overrides file. A missing file means no overrides. */
export async function loadWhisperOverrides(file: string): Promise<ResolvedOverrides> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new ToolsError('TOOLS_OVERRIDES_INVALID', `cannot read ${file}`, undefined, cause);
  }
  const fail = (detail: string): ToolsError =>
    new ToolsError(
      'TOOLS_OVERRIDES_INVALID',
      `${file}: ${detail}`,
      'expected schema_version: 1 and optional binary_path / model_path',
    );
  const yaml = parseYaml(text);
  if (!yaml.ok) throw fail(yaml.issues.map((i) => i.message).join('; '));
  const result = validateContract('whisper-overrides', yaml.parsed.value);
  if (!result.ok) throw fail(result.errors.map((e) => `${e.path} ${e.message}`).join('; '));
  const dir = path.dirname(file);
  const absolute = (value: string | undefined): string | undefined =>
    value === undefined ? undefined : path.resolve(dir, value);
  return {
    binaryPath: absolute(result.value.binary_path),
    modelPath: absolute(result.value.model_path),
  };
}
