import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const srcEntry = fileURLToPath(new URL('../src/cli/main.ts', import.meta.url));
const distEntry = fileURLToPath(new URL('../dist/cli/main.js', import.meta.url));
const binEntry = fileURLToPath(new URL('../bin/recap.js', import.meta.url));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

/** Runs the CLI in a child process, exactly as a user would. */
function runCli(entry: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env) {
  const result = spawnSync(process.execPath, [entry, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    env,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// The TypeScript entry runs through Node 24's built-in type stripping; the
// installed bin shim (which loads dist/) is also checked once `npm run build` has run.
const entries: [string, string][] = [['src', srcEntry]];
if (existsSync(distEntry)) {
  entries.push(['bin', binEntry]);
}

describe.each(entries)('recap CLI (%s)', (_label, entry) => {
  it('prints help', () => {
    const { status, stdout } = runCli(entry, ['--help']);
    expect(status).toBe(0);
    expect(stdout).toContain('Usage: recap');
    expect(stdout).toContain('doctor');
  });

  it('prints the version', () => {
    const { status, stdout } = runCli(entry, ['--version']);
    expect(status).toBe(0);
    expect(stdout.trim()).toBe(pkg.version);
  });

  it('runs doctor and exits 0 whether or not ffmpeg is installed', () => {
    const { status, stdout } = runCli(entry, ['doctor']);
    expect(status).toBe(0);
    expect(stdout).toContain(`node:     ${process.version}`);
    expect(stdout).toContain(`platform: ${process.platform}`);
    expect(stdout).toMatch(/^ {2}ffmpeg: +(ok|MISSING|UNUSABLE)/m);
    expect(stdout).toMatch(/^ {2}ffprobe: +(ok|MISSING|UNUSABLE)/m);
  });

  it('doctor --strict exits 1 with a fix hint when ffmpeg is missing', () => {
    const missing = fileURLToPath(new URL('./no-such-dir/ffmpeg.exe', import.meta.url));
    const env = { ...process.env, RECAP_FFMPEG: missing, RECAP_FFPROBE: missing };
    const plain = runCli(entry, ['doctor'], env);
    expect(plain.status).toBe(0);
    expect(plain.stdout).toContain('ffmpeg:   MISSING');
    expect(plain.stdout).toContain('fix: ');
    expect(plain.stdout).toContain('winget install Gyan.FFmpeg');
    expect(plain.stdout).not.toMatch(/\n\s+at /); // no stack trace

    const strict = runCli(entry, ['doctor', '--strict'], env);
    expect(strict.status).toBe(1);
    expect(strict.stdout).toContain('fix: ');
  });

  it('doctor reports the data root, disk and DB without creating anything', () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'recap doctor ü '));
    try {
      const root = path.join(base, 'data');
      const viaEnv = runCli(entry, ['doctor'], { ...process.env, RECAP_DATA_ROOT: root });
      expect(viaEnv.status).toBe(0);
      expect(viaEnv.stdout).toContain(`data:     ${root} (from RECAP_DATA_ROOT)`);
      expect(viaEnv.stdout).toMatch(/^ {2}disk: +\d+(\.\d)? (GiB|MiB) free/m);
      expect(viaEnv.stdout).toMatch(
        /^ {2}db: +not initialized \(created at schema v\d+ on first use\)/m,
      );
      expect(existsSync(root)).toBe(false);

      const viaFlag = runCli(entry, ['doctor', '--data-root', root], {
        ...process.env,
        RECAP_DATA_ROOT: path.join(base, 'ignored'),
      });
      expect(viaFlag.stdout).toContain(`(from --data-root)`);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('doctor --strict refuses a data root inside the repository', () => {
    const inRepo = fileURLToPath(new URL('./no-such-data-root', import.meta.url));
    const strict = runCli(entry, ['doctor', '--strict', '--data-root', inRepo]);
    expect(strict.status).toBe(1);
    expect(strict.stdout).toContain('[PATHS_DATA_ROOT_IN_REPO]');
    expect(strict.stdout).toContain('--allow-in-repo');
    const allowed = runCli(entry, ['doctor', '--data-root', inRepo, '--allow-in-repo']);
    expect(allowed.stdout).toContain('allowed by --allow-in-repo');
    expect(existsSync(inRepo)).toBe(false);
  });

  it('fails on an unknown command', () => {
    const { status, stderr } = runCli(entry, ['does-not-exist']);
    expect(status).not.toBe(0);
    expect(stderr).toContain('unknown command');
  });
});
