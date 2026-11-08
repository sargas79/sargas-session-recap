import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '../log/index.ts';
import { AudioToolError, installHint, type AudioToolName } from './errors.ts';
import { runTool } from './run.ts';
import {
  formatVersion,
  meetsMinimum,
  MIN_FFMPEG_VERSION,
  parseToolVersion,
  type ReleaseVersion,
  type ToolVersion,
} from './version.ts';

/** Environment variables that override PATH lookup. */
export const TOOL_ENV_VARS: Readonly<Record<AudioToolName, string>> = Object.freeze({
  ffmpeg: 'RECAP_FFMPEG',
  ffprobe: 'RECAP_FFPROBE',
});

export const DEFAULT_VERSION_TIMEOUT_MS = 10_000;

/** Subprocess runner; injectable so tests can fake tool output. */
export type ToolRunner = typeof runTool;

export type ToolSource = 'config' | 'env' | 'path';

export interface ToolLocation {
  readonly name: AudioToolName;
  /** Absolute path of the executable. */
  readonly path: string;
  readonly source: ToolSource;
}

export interface ResolvedTool extends ToolLocation {
  readonly version: ToolVersion;
}

export interface AudioToolchainOptions {
  /** Explicit ffmpeg path from the recap config (T04). Wins over env and PATH. */
  readonly ffmpegPath?: string | undefined;
  /** Explicit ffprobe path from the recap config (T04). Wins over env and PATH. */
  readonly ffprobePath?: string | undefined;
  /** Environment to read `RECAP_FFMPEG`, `RECAP_FFPROBE` and `PATH` from. Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  /** Defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform | undefined;
  /** Defaults to {@link MIN_FFMPEG_VERSION}. */
  readonly minimumVersion?: ReleaseVersion | undefined;
  readonly versionTimeoutMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly logger?: Logger | undefined;
  /** Test seam for the `-version` call. Defaults to {@link runTool}. */
  readonly runner?: ToolRunner | undefined;
}

/** Reads an env var; on Windows names are case-insensitive (`Path` vs `PATH`). */
function readEnv(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== 'win32') {
    return env[name];
  }
  const upper = name.toUpperCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === upper) {
      return value;
    }
  }
  return undefined;
}

async function isFile(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}

/**
 * Searches PATH for the tool. On Windows only `.exe` and `.com` are tried:
 * `.cmd`/`.bat` shims would need a shell to run, which this module never uses.
 * The current directory is never searched implicitly.
 */
export async function findOnPath(
  name: string,
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): Promise<string | undefined> {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const rawPath = readEnv(env, 'PATH', platform) ?? '';
  const extensions = platform === 'win32' ? ['.exe', '.com'] : [''];
  for (const rawDir of rawPath.split(platform === 'win32' ? ';' : ':')) {
    const dir = rawDir.trim().replace(/^"(.*)"$/, '$1');
    if (dir.length === 0 || !pathApi.isAbsolute(dir)) {
      continue;
    }
    for (const extension of extensions) {
      const candidate = pathApi.join(dir, `${name}${extension}`);
      if (await isFile(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

/**
 * Finds the executable: config path, then `RECAP_FFMPEG`/`RECAP_FFPROBE`, then
 * PATH. An explicit config or env path is authoritative: if it is wrong, this
 * fails instead of silently falling back to a different binary on PATH.
 */
export async function locateTool(
  name: AudioToolName,
  options: AudioToolchainOptions = {},
): Promise<ToolLocation> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const configured = name === 'ffmpeg' ? options.ffmpegPath : options.ffprobePath;
  const envVar = TOOL_ENV_VARS[name];
  const fromEnv = readEnv(env, envVar, platform);

  const explicit: [ToolSource, string, string] | undefined =
    configured !== undefined && configured.trim().length > 0
      ? ['config', configured.trim(), `the configured ${name} path`]
      : fromEnv !== undefined && fromEnv.trim().length > 0
        ? ['env', fromEnv.trim(), envVar]
        : undefined;

  if (explicit !== undefined) {
    const [source, rawPath, label] = explicit;
    const resolved = path.resolve(rawPath);
    if (!(await isFile(resolved))) {
      throw new AudioToolError(
        'AUDIO_TOOL_NOT_FOUND',
        `${name} not found at ${resolved} (from ${label})`,
        {
          tool: name,
          hint: `point ${label} at the ${name} executable itself (e.g. C:\\ffmpeg\\bin\\${name}.exe), or unset it to use PATH. ${installHint(name)}`,
        },
      );
    }
    return { name, path: resolved, source };
  }

  const found = await findOnPath(name, env, platform);
  if (found === undefined) {
    throw new AudioToolError('AUDIO_TOOL_NOT_FOUND', `${name} not found on PATH`, {
      tool: name,
      hint: installHint(name),
    });
  }
  return { name, path: found, source: 'path' };
}

/** Locates the tool, runs `-version` and checks it against the minimum. */
export async function resolveTool(
  name: AudioToolName,
  options: AudioToolchainOptions = {},
): Promise<ResolvedTool> {
  const location = await locateTool(name, options);
  const runner = options.runner ?? runTool;
  const minimum = options.minimumVersion ?? MIN_FFMPEG_VERSION;
  const result = await runner(location.path, ['-version'], {
    tool: name,
    timeoutMs: options.versionTimeoutMs ?? DEFAULT_VERSION_TIMEOUT_MS,
    signal: options.signal,
    logger: options.logger,
    maxOutputBytes: 1024 * 1024,
  });
  // The header normally goes to stdout; accept stderr too for unusual builds.
  const version = parseToolVersion(result.stdout, name) ?? parseToolVersion(result.stderr, name);
  if (result.exitCode !== 0 || version === undefined) {
    throw new AudioToolError(
      'AUDIO_TOOL_UNRECOGNIZED',
      `${location.path} does not look like ${name} (could not read its version)`,
      {
        tool: name,
        exitCode: result.exitCode,
        hint: `make sure the path points to a real FFmpeg ${name} build. ${installHint(name)}`,
      },
    );
  }
  if (!meetsMinimum(version, minimum)) {
    throw new AudioToolError(
      'AUDIO_TOOL_TOO_OLD',
      `${name} ${version.raw} at ${location.path} is too old (minimum ${formatVersion(minimum)})`,
      {
        tool: name,
        hint: `upgrade FFmpeg to ${formatVersion(minimum)} or newer (Windows: \`winget upgrade Gyan.FFmpeg\`), or set ${TOOL_ENV_VARS[name]} to a newer build. Verify with \`recap doctor\`.`,
      },
    );
  }
  return { ...location, version };
}

export interface AudioToolchain {
  readonly ffmpeg: ResolvedTool;
  readonly ffprobe: ResolvedTool;
}

/** Resolves both tools, failing on the first problem. */
export async function resolveAudioToolchain(
  options: AudioToolchainOptions = {},
): Promise<AudioToolchain> {
  const [ffmpeg, ffprobe] = await Promise.all([
    resolveTool('ffmpeg', options),
    resolveTool('ffprobe', options),
  ]);
  return { ffmpeg, ffprobe };
}
