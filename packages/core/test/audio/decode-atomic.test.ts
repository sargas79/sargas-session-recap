// decodeToPcm16kMono finalizes through the T03 atomic helper. These tests use a fake ffmpeg
// runner, so they run without ffmpeg installed.
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decodeToPcm16kMono, type ResolvedTool } from '../../src/audio/index.ts';
import { fakeRunner } from './helpers.ts';

let dir: string;
const ffmpeg = { name: 'ffmpeg', path: 'ffmpeg', source: 'PATH' } as unknown as ResolvedTool;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'recap-decode-'));
  writeFileSync(path.join(dir, 'in.flac'), 'input');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('decodeToPcm16kMono atomic finalization', () => {
  it('replaces the destination with the complete temp output', async () => {
    const target = path.join(dir, 'out.wav');
    writeFileSync(target, 'old');
    const { runner } = fakeRunner(({ args }) => {
      writeFileSync(args.at(-1) ?? '', 'RIFF new');
      return {};
    });
    await decodeToPcm16kMono(path.join(dir, 'in.flac'), target, { ffmpeg, runner });
    expect(readFileSync(target, 'utf8')).toBe('RIFF new');
    expect(readdirSync(dir).sort()).toEqual(['in.flac', 'out.wav']);
  });

  it('leaves the destination untouched when ffmpeg fails', async () => {
    const target = path.join(dir, 'out.wav');
    writeFileSync(target, 'old');
    const { runner } = fakeRunner(({ args }) => {
      writeFileSync(args.at(-1) ?? '', 'RIFF partial');
      return { exitCode: 1, stderr: 'boom' };
    });
    await expect(
      decodeToPcm16kMono(path.join(dir, 'in.flac'), target, { ffmpeg, runner }),
    ).rejects.toThrow();
    expect(readFileSync(target, 'utf8')).toBe('old');
    expect(readdirSync(dir).sort()).toEqual(['in.flac', 'out.wav']);
  });
});
