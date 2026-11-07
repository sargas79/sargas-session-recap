import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createLogger } from '../../src/log/index.ts';
import {
  AudioToolError,
  checkAudioToolchain,
  decodeToPcm16kMono,
  detectSilences,
  formatAudioToolCheck,
  locateTool,
  probeAudio,
  resolveTool,
  runTool,
} from '../../src/audio/index.ts';
import { doctorReport } from '../../src/cli/program.ts';
import { fakeRunner, fixture, versionRunner } from './helpers.ts';

const exe = process.platform === 'win32' ? '.exe' : '';
const root = mkdtempSync(path.join(tmpdir(), 'recap-toolchain-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Creates a placeholder executable file (never run) in a fresh directory. */
function fakeBinDir(name: string, tools: readonly string[] = ['ffmpeg', 'ffprobe']): string {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  for (const tool of tools) {
    writeFileSync(path.join(dir, `${tool}${exe}`), '');
  }
  return dir;
}

async function catchError(promise: Promise<unknown>): Promise<AudioToolError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AudioToolError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected an AudioToolError');
}

describe('locateTool', () => {
  const pathDir = fakeBinDir('on path');
  const envDir = fakeBinDir('from env ação');
  const configDir = fakeBinDir('from config');

  it('finds the tool on PATH and returns an absolute path', async () => {
    const location = await locateTool('ffmpeg', { env: { PATH: pathDir } });
    expect(location).toEqual({
      name: 'ffmpeg',
      path: path.join(pathDir, `ffmpeg${exe}`),
      source: 'path',
    });
  });

  it('skips empty, relative and missing PATH entries', async () => {
    const sep = process.platform === 'win32' ? ';' : ':';
    const env = { PATH: ['', 'relative/bin', path.join(root, 'nope'), pathDir].join(sep) };
    expect((await locateTool('ffprobe', { env })).path).toBe(path.join(pathDir, `ffprobe${exe}`));
  });

  it.runIf(process.platform === 'win32')(
    'reads Path case-insensitively and ignores .cmd shims on Windows',
    async () => {
      const shimDir = path.join(root, 'shim');
      mkdirSync(shimDir, { recursive: true });
      writeFileSync(path.join(shimDir, 'ffmpeg.cmd'), '@echo off');
      const location = await locateTool('ffmpeg', { env: { Path: `${shimDir};${pathDir}` } });
      expect(location.path).toBe(path.join(pathDir, 'ffmpeg.exe'));
    },
  );

  it('prefers RECAP_FFMPEG / RECAP_FFPROBE over PATH', async () => {
    const env = {
      PATH: pathDir,
      RECAP_FFMPEG: path.join(envDir, `ffmpeg${exe}`),
      RECAP_FFPROBE: path.join(envDir, `ffprobe${exe}`),
    };
    expect(await locateTool('ffmpeg', { env })).toMatchObject({ source: 'env' });
    expect((await locateTool('ffprobe', { env })).path).toBe(path.join(envDir, `ffprobe${exe}`));
  });

  it('prefers the config path over env and PATH', async () => {
    const env = { PATH: pathDir, RECAP_FFMPEG: path.join(envDir, `ffmpeg${exe}`) };
    const location = await locateTool('ffmpeg', {
      env,
      ffmpegPath: path.join(configDir, `ffmpeg${exe}`),
    });
    expect(location).toMatchObject({
      source: 'config',
      path: path.join(configDir, `ffmpeg${exe}`),
    });
  });

  it('fails with an actionable error when the tool is missing everywhere', async () => {
    const error = await catchError(
      locateTool('ffmpeg', { env: { PATH: path.join(root, 'empty') } }),
    );
    expect(error.code).toBe('AUDIO_TOOL_NOT_FOUND');
    expect(error.message).toBe('ffmpeg not found on PATH');
    expect(error.hint).toContain('winget install Gyan.FFmpeg');
    expect(error.hint).toContain('RECAP_FFMPEG');
    expect(error.hint).toContain('recap doctor');
    expect(error.toUserMessage()).toContain('fix: ');
  });

  it('does not silently fall back to PATH when an explicit path is wrong', async () => {
    const missing = path.join(root, 'no such dir', `ffprobe${exe}`);
    const error = await catchError(
      locateTool('ffprobe', { env: { PATH: pathDir, RECAP_FFPROBE: missing } }),
    );
    expect(error.code).toBe('AUDIO_TOOL_NOT_FOUND');
    expect(error.message).toContain('RECAP_FFPROBE');
    expect(error.message).toContain(missing);
  });

  it('rejects a directory given as the tool path', async () => {
    const error = await catchError(locateTool('ffmpeg', { ffmpegPath: configDir, env: {} }));
    expect(error.code).toBe('AUDIO_TOOL_NOT_FOUND');
    expect(error.hint).toContain('executable itself');
  });
});

describe('resolveTool version check', () => {
  const dir = fakeBinDir('versioned');
  const env = { PATH: dir };

  it('accepts a supported release and reports it', async () => {
    const { runner, calls } = versionRunner('7.1.1-essentials_build-www.gyan.dev');
    const tool = await resolveTool('ffmpeg', { env, runner });
    expect(tool.version).toMatchObject({ kind: 'release', release: { major: 7, minor: 1 } });
    expect(calls[0]?.args).toEqual(['-version']);
    expect(calls[0]?.options.timeoutMs).toBeGreaterThan(0);
  });

  it('rejects a too-old version with an upgrade hint', async () => {
    const { runner } = fakeRunner(() => ({ stdout: fixture('ffmpeg-version-4.4.2-ubuntu.txt') }));
    const error = await catchError(resolveTool('ffmpeg', { env, runner }));
    expect(error.code).toBe('AUDIO_TOOL_TOO_OLD');
    expect(error.message).toContain('4.4.2-0ubuntu0.22.04.1');
    expect(error.message).toContain('minimum 6.0.0');
    expect(error.hint).toContain('winget upgrade Gyan.FFmpeg');
  });

  it('honours a custom minimum', async () => {
    const { runner } = versionRunner('6.1.1-3ubuntu5');
    const error = await catchError(
      resolveTool('ffprobe', { env, runner, minimumVersion: { major: 7, minor: 0, patch: 0 } }),
    );
    expect(error.code).toBe('AUDIO_TOOL_TOO_OLD');
  });

  it('rejects a binary that is not ffmpeg (real subprocess: node)', async () => {
    const error = await catchError(
      resolveTool('ffmpeg', { env: { RECAP_FFMPEG: process.execPath } }),
    );
    expect(error.code).toBe('AUDIO_TOOL_UNRECOGNIZED');
    expect(error.hint).toContain('real FFmpeg');
  });

  it('rejects output from the other tool', async () => {
    const { runner } = fakeRunner(() => ({ stdout: fixture('ffmpeg-version-7.1.1-gyan.txt') }));
    const error = await catchError(resolveTool('ffprobe', { env, runner }));
    expect(error.code).toBe('AUDIO_TOOL_UNRECOGNIZED');
  });
});

describe('operations fail cleanly without ffmpeg', () => {
  const env = { PATH: path.join(root, 'empty') };
  const input = path.join(root, 'input file.wav');
  writeFileSync(input, 'not really audio');

  it('probeAudio reports a missing ffprobe, not a stack trace', async () => {
    const error = await catchError(probeAudio(input, { env }));
    expect(error.code).toBe('AUDIO_TOOL_NOT_FOUND');
    expect(error.tool).toBe('ffprobe');
  });

  it('decodeToPcm16kMono reports a missing ffmpeg', async () => {
    const error = await catchError(decodeToPcm16kMono(input, path.join(root, 'out.wav'), { env }));
    expect(error.code).toBe('AUDIO_TOOL_NOT_FOUND');
    expect(error.tool).toBe('ffmpeg');
  });

  it('detectSilences reports a missing tool', async () => {
    const error = await catchError(
      detectSilences(input, { thresholdDb: -30, minSilenceMs: 500 }, { env }),
    );
    expect(error.code).toBe('AUDIO_TOOL_NOT_FOUND');
  });

  it('rejects a missing input before running anything', async () => {
    const { runner, calls } = versionRunner('7.1');
    const error = await catchError(probeAudio(path.join(root, 'missing.wav'), { env, runner }));
    expect(error.code).toBe('AUDIO_INVALID_ARGUMENT');
    expect(calls).toHaveLength(0);
  });

  it('rejects decoding onto the input itself', async () => {
    const error = await catchError(decodeToPcm16kMono(input, input, { env }));
    expect(error.code).toBe('AUDIO_INVALID_ARGUMENT');
  });
});

describe('operations with a fake runner', () => {
  const dir = fakeBinDir('ops');
  const env = { PATH: dir };
  const input = path.join(root, 'ação teste', 'áudio.wav');
  mkdirSync(path.dirname(input), { recursive: true });
  writeFileSync(input, 'placeholder');

  it('probeAudio passes the absolute path as one argument and parses the JSON', async () => {
    const { runner, calls } = fakeRunner(({ args }) =>
      args.includes('-version')
        ? { stdout: 'ffprobe version 7.1 Copyright' }
        : { stdout: fixture('ffprobe-wav-48k-stereo.json') },
    );
    const probe = await probeAudio(input, { env, runner });
    expect(probe.sampleCount).toBe(216_000);
    expect(calls[1]?.args.at(-1)).toBe(input);
  });

  it('detectSilences closes the trailing silence at the probed duration', async () => {
    const { runner } = fakeRunner(({ args, options }) => {
      if (args.includes('-version')) {
        return { stdout: `${options.tool} version 7.1 Copyright` };
      }
      return options.tool === 'ffprobe'
        ? { stdout: fixture('ffprobe-wav-48k-stereo.json') }
        : { stderr: fixture('silencedetect-ffmpeg6-trailing.txt') };
    });
    const silences = await detectSilences(
      input,
      { thresholdDb: -30, minSilenceMs: 500 },
      { env, runner },
    );
    expect(silences).toEqual([
      { startMs: 1000, endMs: 2000 },
      { startMs: 3000, endMs: 4500 },
    ]);
  });

  it('turns a non-zero ffmpeg exit into AUDIO_PROCESS_FAILED with a short detail', async () => {
    const { runner } = fakeRunner(({ args }) =>
      args.includes('-version')
        ? { stdout: 'ffmpeg version 7.1 Copyright' }
        : { exitCode: 1, stderr: `line one\n${input}: Invalid data found when processing input\n` },
    );
    const error = await catchError(
      decodeToPcm16kMono(input, path.join(root, 'decoded.wav'), { env, runner }),
    );
    expect(error.code).toBe('AUDIO_PROCESS_FAILED');
    expect(error.exitCode).toBe(1);
    expect(error.detail).toContain('Invalid data found');
    expect(error.message).not.toContain('Invalid data');
  });
});

describe('runTool', () => {
  const node = process.execPath;

  it('passes arguments verbatim without a shell (spaces, quotes, non-ASCII)', async () => {
    const args = ['ação teste/áudio.wav', 'a b "c" & echo pwned', '%PATH%', '$HOME'];
    const result = await runTool(
      node,
      ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(-4)))', ...args],
      { tool: 'ffmpeg', timeoutMs: 20_000 },
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(args);
  });

  it('returns a non-zero exit code instead of throwing', async () => {
    const result = await runTool(node, ['-e', 'process.exit(3)'], {
      tool: 'ffmpeg',
      timeoutMs: 20_000,
    });
    expect(result.exitCode).toBe(3);
  });

  it('kills the process and throws AUDIO_TIMEOUT when the timeout elapses', async () => {
    const started = Date.now();
    const error = await catchError(
      runTool(node, ['-e', 'setTimeout(() => {}, 60000)'], { tool: 'ffmpeg', timeoutMs: 300 }),
    );
    expect(error.code).toBe('AUDIO_TIMEOUT');
    expect(error.message).toContain('300 ms');
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it('honours an AbortSignal', async () => {
    const controller = new AbortController();
    const pending = runTool(node, ['-e', 'setTimeout(() => {}, 60000)'], {
      tool: 'ffprobe',
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    setTimeout(() => {
      controller.abort();
    }, 100);
    expect((await catchError(pending)).code).toBe('AUDIO_ABORTED');
  });

  it('rejects immediately when already aborted', async () => {
    const error = await catchError(
      runTool(node, ['-e', ''], { tool: 'ffmpeg', timeoutMs: 1000, signal: AbortSignal.abort() }),
    );
    expect(error.code).toBe('AUDIO_ABORTED');
  });

  it('caps captured output', async () => {
    const error = await catchError(
      runTool(node, ['-e', 'process.stdout.write("x".repeat(100000))'], {
        tool: 'ffmpeg',
        timeoutMs: 20_000,
        maxOutputBytes: 1000,
      }),
    );
    expect(error.code).toBe('AUDIO_OUTPUT_TOO_LARGE');
  });

  it('reports a missing executable as AUDIO_TOOL_NOT_FOUND', async () => {
    const error = await catchError(
      runTool(path.join(root, 'nope', `ffmpeg${exe}`), ['-version'], {
        tool: 'ffmpeg',
        timeoutMs: 5000,
      }),
    );
    expect(error.code).toBe('AUDIO_TOOL_NOT_FOUND');
    expect(error.hint).toContain('winget install Gyan.FFmpeg');
  });

  it('logs only the tool name, status and duration (no args, no output)', async () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'debug', sink: (line) => lines.push(line) });
    await runTool(node, ['-e', 'process.stderr.write("SECRET-STDERR")', 'secret-arg.wav'], {
      tool: 'ffmpeg',
      timeoutMs: 20_000,
      logger,
    });
    const raw = lines.join('\n');
    expect(lines).toHaveLength(1);
    expect(raw).not.toContain('SECRET-STDERR');
    expect(raw).not.toContain('secret-arg');
    expect(JSON.parse(raw)).toMatchObject({ event: 'audio.tool.run', command: 'ffmpeg' });
  });
});

describe('doctor checks', () => {
  const dir = fakeBinDir('doctor');

  it('reports presence, version and path', async () => {
    const { runner } = versionRunner('7.1.1-essentials_build-www.gyan.dev');
    const checks = await checkAudioToolchain({ env: { PATH: dir }, runner });
    expect(checks.every((check) => check.ok)).toBe(true);
    const lines = checks.flatMap(formatAudioToolCheck);
    expect(lines[0]).toContain('ffmpeg:');
    expect(lines[0]).toContain('ok 7.1.1');
    expect(lines.join('\n')).toContain(path.join(dir, `ffprobe${exe}`));
    expect(lines.join('\n')).toContain('(from PATH)');
  });

  it('adds a precision note below the recommended version', async () => {
    const { runner } = versionRunner('6.1.1-3ubuntu5');
    const report = await doctorReport({ env: { PATH: dir }, runner });
    expect(report.ok).toBe(true);
    expect(report.lines.join('\n')).toContain('7.0.0+ recommended');
  });

  it('reports a missing tool with a fix and ok=false', async () => {
    const report = await doctorReport({ env: { PATH: path.join(root, 'empty') } });
    expect(report.ok).toBe(false);
    const text = report.lines.join('\n');
    expect(text).toContain('ffmpeg:   MISSING');
    expect(text).toContain('fix: install FFmpeg');
  });

  it('reports a too-old tool as UNUSABLE', async () => {
    const { runner } = versionRunner('5.1.6');
    const report = await doctorReport({ env: { PATH: dir }, runner });
    expect(report.ok).toBe(false);
    expect(report.lines.join('\n')).toContain('UNUSABLE');
    expect(report.lines.join('\n')).toContain('AUDIO_TOOL_TOO_OLD');
  });
});
