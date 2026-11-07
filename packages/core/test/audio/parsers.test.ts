import { describe, expect, it } from 'vitest';
import { scaleDecimal, secondsToMs } from '../../src/audio/decimal.ts';
import {
  AudioToolError,
  decodeArgs,
  meetsMinimum,
  parseProbeJson,
  parseSilenceDetect,
  parseToolVersion,
  probeArgs,
  silenceArgs,
  silenceFilter,
} from '../../src/audio/index.ts';
import { fixture } from './helpers.ts';

describe('exact decimal parsing', () => {
  it.each([
    ['0', 0],
    ['4.500000', 4500],
    ['1.00002', 1000],
    ['0.0005', 1], // half rounds away from zero
    ['0.00049', 0],
    ['2.08333e-05', 0],
    ['1.5e3', 1_500_000],
    ['-0.0015', -2],
    ['.25', 250],
    ['10925', 10_925_000],
  ])('secondsToMs(%s) = %d', (text, expected) => {
    expect(secondsToMs(text)).toBe(expected);
  });

  it.each(['', 'abc', '1.2.3', 'N/A', '1e', 'inf', 'nan'])('rejects %j', (text) => {
    expect(secondsToMs(text)).toBeUndefined();
  });

  it('scales without floating-point error', () => {
    // 0.1 + 0.2 style traps: 4.35 * 16000 is 69599.99999999999 in floats.
    expect(scaleDecimal('4.35', 16_000n)).toBe(69_600n);
    expect(scaleDecimal('7322.481000', 48_000n)).toBe(351_479_088n);
  });
});

describe('parseToolVersion', () => {
  it('parses a Gyan Windows release build', () => {
    expect(parseToolVersion(fixture('ffmpeg-version-7.1.1-gyan.txt'), 'ffmpeg')).toEqual({
      kind: 'release',
      raw: '7.1.1-essentials_build-www.gyan.dev',
      release: { major: 7, minor: 1, patch: 1 },
    });
  });

  it('parses an Ubuntu ffprobe build', () => {
    expect(parseToolVersion(fixture('ffprobe-version-6.1.1-ubuntu.txt'), 'ffprobe')).toMatchObject({
      kind: 'release',
      release: { major: 6, minor: 1, patch: 1 },
    });
  });

  it('parses an old build so it can be rejected', () => {
    const version = parseToolVersion(fixture('ffmpeg-version-4.4.2-ubuntu.txt'), 'ffmpeg');
    expect(version).toMatchObject({ kind: 'release', release: { major: 4, minor: 4, patch: 2 } });
    expect(version !== undefined && meetsMinimum(version)).toBe(false);
  });

  it('accepts development (git) builds without a numeric check', () => {
    const version = parseToolVersion(fixture('ffmpeg-version-git-gyan.txt'), 'ffmpeg');
    expect(version).toEqual({
      kind: 'development',
      raw: '2025-01-30-git-1911a6ec26-full_build-www.gyan.dev',
    });
    expect(version !== undefined && meetsMinimum(version)).toBe(true);
    expect(parseToolVersion('ffmpeg version N-118000-gabc123-20250101', 'ffmpeg')?.kind).toBe(
      'development',
    );
  });

  it.each([
    ['ffmpeg version n7.0.2 Copyright', { major: 7, minor: 0, patch: 2 }],
    ['ffmpeg version 6.0 Copyright', { major: 6, minor: 0, patch: 0 }],
    ['ffmpeg version 8.0-full_build', { major: 8, minor: 0, patch: 0 }],
  ])('parses %j', (text, release) => {
    expect(parseToolVersion(text, 'ffmpeg')).toMatchObject({ kind: 'release', release });
  });

  it('rejects output from the wrong tool or unknown formats', () => {
    expect(parseToolVersion(fixture('ffmpeg-version-7.1.1-gyan.txt'), 'ffprobe')).toBeUndefined();
    expect(parseToolVersion('node: bad option: -version', 'ffmpeg')).toBeUndefined();
    expect(parseToolVersion('ffmpeg version weird-build', 'ffmpeg')).toBeUndefined();
  });

  it('enforces the documented minimum of 6.0', () => {
    const at = (raw: string) => {
      const version = parseToolVersion(`ffmpeg version ${raw}`, 'ffmpeg');
      if (version === undefined) {
        throw new Error(`unparsed ${raw}`);
      }
      return meetsMinimum(version);
    };
    expect(at('5.1.6')).toBe(false);
    expect(at('6.0')).toBe(true);
    expect(at('6.1.1-3ubuntu5')).toBe(true);
    expect(at('10.0')).toBe(true);
  });
});

describe('parseProbeJson', () => {
  it('reads a 48 kHz stereo WAV exactly', () => {
    expect(parseProbeJson(fixture('ffprobe-wav-48k-stereo.json'))).toEqual({
      durationMs: 4500,
      sampleRate: 48_000,
      channels: 2,
      codec: 'pcm_s16le',
      sampleCount: 216_000,
    });
  });

  it('uses duration_ts when the time base equals the sample rate', () => {
    expect(parseProbeJson(fixture('ffprobe-flac-44k-mono.json'))).toEqual({
      durationMs: 60_000,
      sampleRate: 44_100,
      channels: 1,
      codec: 'flac',
      sampleCount: 2_646_001,
    });
  });

  it('converts duration_ts from a non-sample time base exactly', () => {
    expect(parseProbeJson(fixture('ffprobe-mp3-timebase.json'))).toMatchObject({
      sampleCount: 198_450,
      durationMs: 4500,
      codec: 'mp3',
    });
  });

  it('falls back to the container duration', () => {
    expect(parseProbeJson(fixture('ffprobe-webm-opus-format-duration.json'))).toEqual({
      durationMs: 7_322_481,
      sampleRate: 48_000,
      channels: 2,
      codec: 'opus',
      sampleCount: 351_479_088,
    });
  });

  it('returns only integers and is deterministic', () => {
    const json = fixture('ffprobe-webm-opus-format-duration.json');
    const first = parseProbeJson(json);
    expect(parseProbeJson(json)).toEqual(first);
    for (const value of [first.durationMs, first.sampleRate, first.channels, first.sampleCount]) {
      expect(Number.isSafeInteger(value)).toBe(true);
    }
  });

  it('reports a file without audio as AUDIO_NO_AUDIO_STREAM', () => {
    expect(() => parseProbeJson(fixture('ffprobe-no-audio.json'))).toThrow(
      expect.objectContaining({ code: 'AUDIO_NO_AUDIO_STREAM' }) as Error,
    );
  });

  it.each([
    ['not json', 'not valid JSON'],
    ['[]', 'expected a JSON object'],
    ['{"streams":[{"codec_type":"audio","sample_rate":"48000","channels":1}]}', 'codec_name'],
    ['{"streams":[{"codec_name":"flac","sample_rate":"0","channels":1}]}', 'sample_rate'],
    ['{"streams":[{"codec_name":"flac","sample_rate":"8000","channels":0}]}', 'channels'],
    [
      '{"streams":[{"codec_name":"flac","sample_rate":"8000","channels":1,"duration":"N/A"}]}',
      'duration is unknown',
    ],
  ])('rejects malformed output %j with a typed error', (json, message) => {
    let caught: unknown;
    try {
      parseProbeJson(json);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AudioToolError);
    expect((caught as AudioToolError).code).toBe('AUDIO_PARSE_FAILED');
    expect((caught as AudioToolError).message).toContain(message);
  });
});

describe('parseSilenceDetect', () => {
  it('closes a trailing silence without silence_end at the file duration', () => {
    expect(parseSilenceDetect(fixture('silencedetect-ffmpeg6-trailing.txt'), 4500)).toEqual([
      { startMs: 1000, endMs: 2000 },
      { startMs: 3000, endMs: 4500 },
    ]);
  });

  it('drops a trailing silence when the duration is unknown', () => {
    expect(parseSilenceDetect(fixture('silencedetect-ffmpeg6-trailing.txt'))).toEqual([
      { startMs: 1000, endMs: 2000 },
    ]);
  });

  it('handles an EOF silence_end (ffmpeg 7) and Windows-style filter addresses', () => {
    expect(parseSilenceDetect(fixture('silencedetect-ffmpeg7-eof-end.txt'), 4500)).toEqual([
      { startMs: 0, endMs: 500 },
      { startMs: 1000, endMs: 2000 },
      { startMs: 3000, endMs: 4500 },
    ]);
  });

  it('parses %g exponents, clamps negative starts and rounds long timestamps', () => {
    expect(
      parseSilenceDetect(fixture('silencedetect-ffmpeg6-long-g-format.txt'), 10_930_000),
    ).toEqual([
      { startMs: 0, endMs: 4121 },
      { startMs: 987_654, endMs: 989_001 },
      { startMs: 3_725_510, endMs: 3_727_080 },
      { startMs: 10_921_300, endMs: 10_925_000 },
    ]);
  });

  it('accepts CRLF output and clamps to the duration', () => {
    const stderr =
      '[silencedetect @ 0x1] silence_start: 1.5\r\n' +
      '[silencedetect @ 0x1] silence_end: 9.9 | silence_duration: 8.4\r\n';
    expect(parseSilenceDetect(stderr, 5000)).toEqual([{ startMs: 1500, endMs: 5000 }]);
  });

  it('ignores unrelated lines and unmatched ends', () => {
    const stderr = [
      "Input #0, wav, from 'silence_start: 3.wav':",
      '[silencedetect @ 0x1] silence_end: 1 | silence_duration: 1',
      '[silencedetect @ 0x1] silence_start: 2',
      '[silencedetect @ 0x1] silence_end: 2 | silence_duration: 0',
    ].join('\n');
    expect(parseSilenceDetect(stderr, 5000)).toEqual([]);
  });

  it('returns integers and is deterministic', () => {
    const stderr = fixture('silencedetect-ffmpeg6-long-g-format.txt');
    const first = parseSilenceDetect(stderr, 10_930_000);
    expect(parseSilenceDetect(stderr, 10_930_000)).toEqual(first);
    for (const { startMs, endMs } of first) {
      expect(Number.isSafeInteger(startMs) && Number.isSafeInteger(endMs)).toBe(true);
    }
  });

  it('rejects an unparseable timestamp with a typed error', () => {
    expect(() => parseSilenceDetect('[silencedetect @ 0x1] silence_start: garbage', 1000)).toThrow(
      expect.objectContaining({ code: 'AUDIO_PARSE_FAILED' }) as Error,
    );
  });
});

describe('argument builders', () => {
  const input = process.platform === 'win32' ? 'C:\\a b\\ação.wav' : '/a b/ação.wav';

  it('keeps paths as single arguments', () => {
    expect(probeArgs(input).at(-1)).toBe(input);
    expect(decodeArgs(input, `${input}.tmp`).at(-1)).toBe(`${input}.tmp`);
    expect(silenceArgs(input, { thresholdDb: -30, minSilenceMs: 500 })).toContain(input);
  });

  it('uses the deterministic decode settings', () => {
    const args = decodeArgs(input, 'out').join(' ');
    for (const part of [
      '-ac 1',
      '-ar 16000',
      '-c:a pcm_s16le',
      '-map_metadata -1',
      '-bitexact',
      '-map 0:a:0',
      '-f wav',
    ]) {
      expect(args).toContain(part);
    }
  });

  it('formats the silence filter without float noise', () => {
    expect(silenceFilter({ thresholdDb: -30, minSilenceMs: 500 })).toBe(
      'silencedetect=noise=-30.00dB:duration=0.500',
    );
    expect(silenceFilter({ thresholdDb: -42.5, minSilenceMs: 12_345 })).toBe(
      'silencedetect=noise=-42.50dB:duration=12.345',
    );
  });

  it.each([
    [{ thresholdDb: 3, minSilenceMs: 500 }],
    [{ thresholdDb: Number.NaN, minSilenceMs: 500 }],
    [{ thresholdDb: -30, minSilenceMs: 0 }],
    [{ thresholdDb: -30, minSilenceMs: 1.5 }],
  ])('rejects invalid silence params %j', (params) => {
    expect(() => silenceFilter(params)).toThrow(
      expect.objectContaining({ code: 'AUDIO_INVALID_ARGUMENT' }) as Error,
    );
  });
});
