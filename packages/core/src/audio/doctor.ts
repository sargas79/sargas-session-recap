import { AudioToolError, installHint, type AudioToolName } from './errors.ts';
import { resolveTool, type AudioToolchainOptions, type ResolvedTool } from './locate.ts';
import { compareVersions, formatVersion, RECOMMENDED_FFMPEG_VERSION } from './version.ts';

export type AudioToolCheck =
  | {
      readonly name: AudioToolName;
      readonly ok: true;
      readonly tool: ResolvedTool;
      /** Non-fatal advice, e.g. a version below the recommended one. */
      readonly warning: string | undefined;
    }
  | {
      readonly name: AudioToolName;
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly hint: string;
    };

/** Checks one tool without throwing; for `recap doctor`. */
export async function checkAudioTool(
  name: AudioToolName,
  options: AudioToolchainOptions = {},
): Promise<AudioToolCheck> {
  try {
    const tool = await resolveTool(name, options);
    const warning =
      tool.version.kind === 'release' &&
      compareVersions(tool.version.release, RECOMMENDED_FFMPEG_VERSION) < 0
        ? `${formatVersion(RECOMMENDED_FFMPEG_VERSION)}+ recommended: older builds report silence boundaries with reduced precision on long recordings`
        : undefined;
    return { name, ok: true, tool, warning };
  } catch (error) {
    if (error instanceof AudioToolError) {
      return {
        name,
        ok: false,
        code: error.code,
        message: error.message,
        hint: error.hint ?? installHint(name),
      };
    }
    return {
      name,
      ok: false,
      code: 'AUDIO_PROCESS_FAILED',
      message: `${name} check failed unexpectedly`,
      hint: installHint(name),
    };
  }
}

export async function checkAudioToolchain(
  options: AudioToolchainOptions = {},
): Promise<AudioToolCheck[]> {
  return Promise.all([checkAudioTool('ffmpeg', options), checkAudioTool('ffprobe', options)]);
}

const SOURCE_LABEL = { config: 'config', env: 'env', path: 'PATH' } as const;

/** Human-readable doctor lines for one check (first line is `  <name>: ...`). */
export function formatAudioToolCheck(check: AudioToolCheck): string[] {
  const label = `  ${check.name}:`.padEnd(12);
  const indent = ' '.repeat(12);
  if (check.ok) {
    const { tool } = check;
    const version =
      tool.version.kind === 'release'
        ? tool.version.raw
        : `${tool.version.raw} (development build)`;
    const lines = [
      `${label}ok ${version}`,
      `${indent}path: ${tool.path} (from ${SOURCE_LABEL[tool.source]})`,
    ];
    if (check.warning !== undefined) {
      lines.push(`${indent}note: ${check.warning}`);
    }
    return lines;
  }
  const status = check.code === 'AUDIO_TOOL_NOT_FOUND' ? 'MISSING' : 'UNUSABLE';
  return [`${label}${status} - ${check.message} [${check.code}]`, `${indent}fix: ${check.hint}`];
}
