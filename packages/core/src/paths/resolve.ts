import os from 'node:os';
import path from 'node:path';
import { PathsError } from './errors.ts';

/** Directory name appended to the platform's per-user data directory. */
export const APP_DIR_NAME = 'sargas-recap';

/** Environment variable that overrides the data root (ADR-009 step 2). */
export const DATA_ROOT_ENV = 'RECAP_DATA_ROOT';

/** Where the resolved data root came from, in ADR-009 precedence order. */
export type DataRootSource = 'flag' | 'env' | 'config' | 'default';

export type Env = Readonly<Record<string, string | undefined>>;

export interface DataRootInputs {
  /** `--data-root` from the command line. Wins over everything. */
  readonly flag?: string | undefined;
  /** `data_root` from the recap config (T04). Relative values resolve against `configDir`. */
  readonly config?: string | undefined;
  /** Directory of the config file, for relative `config` values. Defaults to `cwd`. */
  readonly configDir?: string | undefined;
  /** Defaults to `process.env`. */
  readonly env?: Env | undefined;
  /** Defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform | undefined;
  /** Defaults to `os.homedir()`. */
  readonly homedir?: string | undefined;
  /** Base for relative `flag`/`env` values. Defaults to `process.cwd()`. */
  readonly cwd?: string | undefined;
}

export interface ResolvedDataRoot {
  /** Absolute, normalized data root. It may not exist yet. */
  readonly root: string;
  readonly source: DataRootSource;
}

type PathApi = typeof path.win32;

export function pathApi(platform: NodeJS.Platform): PathApi {
  return platform === 'win32' ? path.win32 : path.posix;
}

/** Reads an env var; on Windows names are case-insensitive (`LocalAppData`). */
function readEnv(env: Env, name: string, platform: NodeJS.Platform): string | undefined {
  let value = env[name];
  if (value === undefined && platform === 'win32') {
    const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
    value = key === undefined ? undefined : env[key];
  }
  // An empty or blank variable counts as unset, like most shells treat it.
  return value === undefined || value.trim() === '' ? undefined : value;
}

/**
 * Per-user default data root (ADR-009 step 4):
 * - Windows: `%LOCALAPPDATA%\sargas-recap` (falls back to `<home>\AppData\Local`)
 * - macOS:   `~/Library/Application Support/sargas-recap`
 * - other:   `$XDG_DATA_HOME/sargas-recap` (when absolute), else `~/.local/share/sargas-recap`
 */
export function defaultDataRoot(
  options: Pick<DataRootInputs, 'env' | 'platform' | 'homedir'> = {},
): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const p = pathApi(platform);
  const home = options.homedir ?? os.homedir();
  const requireHome = (): string => {
    if (home.trim() === '' || !p.isAbsolute(home)) {
      throw new PathsError(
        'PATHS_NO_DEFAULT',
        'cannot derive the default data root: no usable home directory',
        `pass --data-root or set ${DATA_ROOT_ENV}`,
      );
    }
    return home;
  };

  if (platform === 'win32') {
    const local = readEnv(env, 'LOCALAPPDATA', platform);
    if (local !== undefined && p.isAbsolute(local)) {
      return p.join(local, APP_DIR_NAME);
    }
    return p.join(requireHome(), 'AppData', 'Local', APP_DIR_NAME);
  }
  if (platform === 'darwin') {
    return p.join(requireHome(), 'Library', 'Application Support', APP_DIR_NAME);
  }
  // XDG Base Directory spec: relative values are invalid and must be ignored.
  const xdg = readEnv(env, 'XDG_DATA_HOME', platform);
  if (xdg !== undefined && p.isAbsolute(xdg)) {
    return p.join(xdg, APP_DIR_NAME);
  }
  return p.join(requireHome(), '.local', 'share', APP_DIR_NAME);
}

function absolute(p: PathApi, base: string, value: string): string {
  // `resolve` also normalizes `.`/`..` and duplicate separators.
  return p.resolve(base, value);
}

/**
 * Resolves the data root in ADR-009 order: `--data-root`, `RECAP_DATA_ROOT`,
 * config, platform default. Pure: touches neither the filesystem nor the repo guard.
 */
export function resolveDataRoot(inputs: DataRootInputs = {}): ResolvedDataRoot {
  const env = inputs.env ?? process.env;
  const platform = inputs.platform ?? process.platform;
  const p = pathApi(platform);
  const cwd = inputs.cwd ?? process.cwd();

  if (inputs.flag !== undefined) {
    if (inputs.flag.trim() === '') {
      throw new PathsError('PATHS_DATA_ROOT_INVALID', '--data-root must not be empty');
    }
    return { root: absolute(p, cwd, inputs.flag), source: 'flag' };
  }
  const fromEnv = readEnv(env, DATA_ROOT_ENV, platform);
  if (fromEnv !== undefined) {
    return { root: absolute(p, cwd, fromEnv), source: 'env' };
  }
  if (inputs.config !== undefined && inputs.config.trim() !== '') {
    return { root: absolute(p, inputs.configDir ?? cwd, inputs.config), source: 'config' };
  }
  const root = defaultDataRoot({ env, platform, homedir: inputs.homedir });
  return { root: p.normalize(root), source: 'default' };
}
