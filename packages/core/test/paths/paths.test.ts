import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SLUG_PATTERN as CONTRACTS_SLUG_PATTERN } from '../../../contracts/src/common.ts';
import {
  assertDataRootOutsideRepo,
  assertSlug,
  createDataPaths,
  defaultDataRoot,
  findEnclosingGit,
  openDataRoot,
  PathsError,
  resolveDataRoot,
  SLUG_PATTERN,
} from '../../src/paths/index.ts';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof PathsError ? error.code : 'not-a-PathsError';
  }
  return undefined;
}

describe('resolveDataRoot precedence (ADR-009)', () => {
  const win = {
    platform: 'win32' as const,
    cwd: 'C:\\work',
    homedir: 'C:\\Users\\ana',
  };
  const env = { LOCALAPPDATA: 'C:\\Users\\ana\\AppData\\Local', RECAP_DATA_ROOT: 'D:\\env-root' };

  it('--data-root wins over env, config and default', () => {
    expect(resolveDataRoot({ ...win, env, flag: 'E:\\flag', config: 'F:\\cfg' })).toEqual({
      root: 'E:\\flag',
      source: 'flag',
    });
  });

  it('RECAP_DATA_ROOT wins over config and default', () => {
    expect(resolveDataRoot({ ...win, env, config: 'F:\\cfg' })).toEqual({
      root: 'D:\\env-root',
      source: 'env',
    });
  });

  it('config wins over the default', () => {
    const noEnvRoot = { LOCALAPPDATA: env.LOCALAPPDATA };
    expect(resolveDataRoot({ ...win, env: noEnvRoot, config: 'F:\\cfg' })).toEqual({
      root: 'F:\\cfg',
      source: 'config',
    });
  });

  it('falls back to the platform default', () => {
    expect(resolveDataRoot({ ...win, env: { LOCALAPPDATA: env.LOCALAPPDATA } })).toEqual({
      root: 'C:\\Users\\ana\\AppData\\Local\\sargas-recap',
      source: 'default',
    });
  });

  it('treats an empty RECAP_DATA_ROOT or config as unset', () => {
    const r = resolveDataRoot({ ...win, env: { ...env, RECAP_DATA_ROOT: '  ' }, config: '' });
    expect(r.source).toBe('default');
  });

  it('rejects an empty --data-root', () => {
    expect(codeOf(() => resolveDataRoot({ ...win, env, flag: '' }))).toBe(
      'PATHS_DATA_ROOT_INVALID',
    );
  });

  it('resolves relative values: flag/env against cwd, config against the config dir', () => {
    expect(resolveDataRoot({ ...win, env: {}, flag: '..\\data' }).root).toBe('C:\\data');
    expect(resolveDataRoot({ ...win, env: { RECAP_DATA_ROOT: 'rel' } }).root).toBe('C:\\work\\rel');
    expect(
      resolveDataRoot({ ...win, env: {}, config: 'data', configDir: 'C:\\Users\\ana\\cfg' }).root,
    ).toBe('C:\\Users\\ana\\cfg\\data');
    expect(
      resolveDataRoot({ platform: 'linux', cwd: '/w', homedir: '/h', env: {}, flag: './d/../x' })
        .root,
    ).toBe('/w/x');
  });
});

describe('default data root locations', () => {
  it('Windows: %LOCALAPPDATA% with spaces and non-ASCII user names', () => {
    const local = 'C:\\Users\\José Ñúñez Ålborg 李\\AppData\\Local';
    expect(
      defaultDataRoot({ platform: 'win32', env: { LOCALAPPDATA: local }, homedir: 'C:\\x' }),
    ).toBe(`${local}\\sargas-recap`);
  });

  it('Windows: env var names are case-insensitive', () => {
    expect(
      defaultDataRoot({ platform: 'win32', env: { LocalAppData: 'C:\\L' }, homedir: 'C:\\x' }),
    ).toBe('C:\\L\\sargas-recap');
  });

  it('Windows: falls back to <home>\\AppData\\Local without LOCALAPPDATA', () => {
    expect(defaultDataRoot({ platform: 'win32', env: {}, homedir: 'C:\\Users\\Zoë Ü' })).toBe(
      'C:\\Users\\Zoë Ü\\AppData\\Local\\sargas-recap',
    );
  });

  it('Linux: XDG_DATA_HOME when absolute, else ~/.local/share', () => {
    const home = '/home/zoë müller';
    expect(
      defaultDataRoot({ platform: 'linux', env: { XDG_DATA_HOME: '/x d' }, homedir: home }),
    ).toBe('/x d/sargas-recap');
    expect(
      defaultDataRoot({ platform: 'linux', env: { XDG_DATA_HOME: 'rel' }, homedir: home }),
    ).toBe('/home/zoë müller/.local/share/sargas-recap');
    expect(defaultDataRoot({ platform: 'linux', env: {}, homedir: home })).toBe(
      '/home/zoë müller/.local/share/sargas-recap',
    );
  });

  it('macOS: ~/Library/Application Support', () => {
    expect(defaultDataRoot({ platform: 'darwin', env: {}, homedir: '/Users/Łukasz' })).toBe(
      '/Users/Łukasz/Library/Application Support/sargas-recap',
    );
  });

  it('fails clearly without a usable home directory', () => {
    expect(codeOf(() => defaultDataRoot({ platform: 'linux', env: {}, homedir: '' }))).toBe(
      'PATHS_NO_DEFAULT',
    );
  });
});

describe('data root layout and ID validation', () => {
  const root = path.resolve('/data root/ñ');
  const paths = createDataPaths(root);

  it('builds the ADR-009 layout', () => {
    expect(paths.root).toBe(root);
    expect(paths.dbFile).toBe(path.join(root, 'state', 'recap.sqlite'));
    expect(paths.backupsDir).toBe(path.join(root, 'state', 'backups'));
    expect(paths.toolsDir).toBe(path.join(root, 'tools'));
    expect(paths.logsDir).toBe(path.join(root, 'logs'));
    expect(paths.sessionDir('abomination-vaults', 's07')).toBe(
      path.join(root, 'campaigns', 'abomination-vaults', 'sessions', 's07'),
    );
  });

  it.each([
    '',
    '..',
    '.',
    'a/b',
    'a\\b',
    '../escape',
    'C:',
    'Upper',
    '-lead',
    'trail-',
    'with space',
    'a'.repeat(65),
    'con',
    'nul',
    'com1',
    'lpt9',
  ])('refuses %j as a campaign or session ID', (bad) => {
    expect(codeOf(() => paths.campaignDir(bad))).toBe('PATHS_INVALID_ID');
    expect(codeOf(() => paths.sessionDir('ok', bad))).toBe('PATHS_INVALID_ID');
  });

  it('accepts ADR-004 slugs', () => {
    expect(assertSlug('session_id', 's07')).toBe('s07');
    expect(assertSlug('campaign_id', 'a'.repeat(64))).toBe('a'.repeat(64));
    expect(assertSlug('campaign_id', 'console')).toBe('console');
  });

  it('keeps the slug pattern in sync with contracts', () => {
    expect(SLUG_PATTERN).toBe(CONTRACTS_SLUG_PATTERN);
  });
});

describe('in-repo refusal', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  const tmp = (): string => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'recap-guard-'));
    dirs.push(dir);
    return dir;
  };

  it('refuses a (not yet existing) root below a .git directory', () => {
    const repo = tmp();
    mkdirSync(path.join(repo, '.git'));
    const root = path.join(repo, 'nested', 'data');
    expect(findEnclosingGit(root)).toBe(path.join(repo, '.git'));
    expect(
      codeOf(() => {
        assertDataRootOutsideRepo(root, false);
      }),
    ).toBe('PATHS_DATA_ROOT_IN_REPO');
    expect(codeOf(() => openDataRoot({ flag: root, env: {} }))).toBe('PATHS_DATA_ROOT_IN_REPO');
  });

  it('refuses a root inside a git worktree (.git is a file)', () => {
    const repo = tmp();
    writeFileSync(path.join(repo, '.git'), 'gitdir: /elsewhere/.git/worktrees/x\n');
    expect(codeOf(() => openDataRoot({ flag: path.join(repo, 'd'), env: {} }))).toBe(
      'PATHS_DATA_ROOT_IN_REPO',
    );
  });

  it('refuses the repo root itself and env/default sources too', () => {
    const repo = tmp();
    mkdirSync(path.join(repo, '.git'));
    expect(codeOf(() => openDataRoot({ env: { RECAP_DATA_ROOT: repo } }))).toBe(
      'PATHS_DATA_ROOT_IN_REPO',
    );
    expect(
      codeOf(() =>
        openDataRoot({ env: { LOCALAPPDATA: repo, XDG_DATA_HOME: repo }, homedir: repo }),
      ),
    ).toBe('PATHS_DATA_ROOT_IN_REPO');
  });

  it('allows it with --allow-in-repo', () => {
    const repo = tmp();
    mkdirSync(path.join(repo, '.git'));
    const opened = openDataRoot({ flag: path.join(repo, 'd'), env: {}, allowInRepo: true });
    expect(opened.source).toBe('flag');
    expect(opened.paths.root).toBe(path.join(repo, 'd'));
  });

  it('accepts a root outside any git working tree', () => {
    const root = path.join(tmp(), 'data');
    const exists = (p: string): boolean => p === path.join(path.parse(root).root, 'never', '.git');
    expect(findEnclosingGit(root, exists)).toBeUndefined();
    expect(() => {
      assertDataRootOutsideRepo(root, false, exists);
    }).not.toThrow();
  });

  it('detects this repository', () => {
    const here = path.resolve(import.meta.dirname, 'some-data');
    expect(codeOf(() => openDataRoot({ flag: here, env: {} }))).toBe('PATHS_DATA_ROOT_IN_REPO');
  });
});
