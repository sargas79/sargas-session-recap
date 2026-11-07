import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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

  it('fails on an unknown command', () => {
    const { status, stderr } = runCli(entry, ['does-not-exist']);
    expect(status).not.toBe(0);
    expect(stderr).toContain('unknown command');
  });
});
