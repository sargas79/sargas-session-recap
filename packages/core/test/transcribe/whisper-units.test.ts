import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AsrParams, ChunkPlanChunk } from '@sargas-recap/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildChunkSegments,
  buildWhisperPrompt,
  findRepetitionLoops,
  flagRepetitionLoops,
  normalizeTimings,
  parseWhisperJson,
  planPromptDelivery,
  PROVISIONAL_ASR_DEFAULTS,
  resolveAsrParams,
  whisperArgs,
  whisperLanguage,
  wordsOf,
  WhisperOutputError,
} from '../../src/transcribe/index.ts';
import {
  MAX_DECODE_SHORTFALL_MS,
  MIN_WHISPER_AUDIO_MS,
  writeChunkWav,
} from '../../src/transcribe/chunk-audio.ts';
import { asrOutputParams } from '../../src/transcribe/asr-params.ts';

const params: AsrParams = PROVISIONAL_ASR_DEFAULTS;
const REPETITION = { minRepeats: 3, minWords: 12, maxUnitWords: 120 };

describe('parseWhisperJson', () => {
  it('reads integer offsets and token probabilities, ignoring unknown fields', () => {
    const output = parseWhisperJson(
      JSON.stringify({
        systeminfo: 'x',
        transcription: [
          {
            offsets: { from: 0, to: 4320 },
            text: ' olá',
            tokens: [
              { text: '[_BEG_]', p: 0.5 },
              { text: ' olá', p: 0.75, extra: true },
            ],
          },
        ],
      }),
    );
    expect(output.segments).toEqual([
      {
        fromMs: 0,
        toMs: 4320,
        text: ' olá',
        tokens: [
          { text: '[_BEG_]', probability: 0.5, special: true },
          { text: ' olá', probability: 0.75, special: false },
        ],
      },
    ]);
  });

  it('falls back to the timestamp strings and rounds floats to integers', () => {
    const output = parseWhisperJson(
      JSON.stringify({
        transcription: [
          { timestamps: { from: '00:01:02,500', to: '01:00:00.1' }, text: 'a' },
          { offsets: { from: 10.4, to: 20.6 }, text: 'b' },
          { text: 'c' },
        ],
      }),
    );
    expect(output.segments.map((s) => [s.fromMs, s.toMs])).toEqual([
      [62_500, 3_600_100],
      [10, 21],
      [undefined, undefined],
    ]);
  });

  it('accepts a raw control character, which the real writer does not escape', () => {
    const raw = '{"transcription":[{"text":" a\u0001b","offsets":{"from":0,"to":1}}]}';
    expect(parseWhisperJson(raw).segments[0]?.text).toBe(' a b');
  });

  it.each([
    ['not json', 'nope'],
    ['no transcription', '{}'],
    ['transcription is not an array', '{"transcription":3}'],
    ['segment is not an object', '{"transcription":[3]}'],
  ])('rejects %s without quoting the file', (_name, raw) => {
    expect(() => parseWhisperJson(raw)).toThrow(WhisperOutputError);
    try {
      parseWhisperJson(raw);
    } catch (error) {
      expect((error as Error).message).not.toContain(raw);
    }
  });
});

describe('normalizeTimings', () => {
  const duration = 10_000;

  it('leaves valid, overlapping-neighbor timings alone', () => {
    expect(
      normalizeTimings(
        [
          { fromMs: 0, toMs: 1000 },
          { fromMs: 900, toMs: 2000 },
        ],
        duration,
      ),
    ).toEqual([
      { startMs: 0, endMs: 1000, clamped: false },
      { startMs: 900, endMs: 2000, clamped: false },
    ]);
  });

  it.each([
    ['end before start', { fromMs: 500, toMs: 100 }, 500, 500],
    ['negative start', { fromMs: -10, toMs: 100 }, 0, 100],
    ['end past the chunk', { fromMs: 9000, toMs: 20_000 }, 9000, duration],
    ['start past the chunk', { fromMs: 20_000, toMs: 30_000 }, duration, duration],
    ['missing start', { fromMs: undefined, toMs: 400 }, 0, 400],
    ['missing end', { fromMs: 300, toMs: undefined }, 300, 300],
  ])('clamps %s and marks it', (_name, reported, startMs, endMs) => {
    expect(normalizeTimings([reported], duration)).toEqual([{ startMs, endMs, clamped: true }]);
  });

  it('keeps starts monotonic after a segment that goes backwards', () => {
    const result = normalizeTimings(
      [
        { fromMs: 2000, toMs: 3000 },
        { fromMs: 1000, toMs: 2500 },
      ],
      duration,
    );
    expect(result[1]).toEqual({ startMs: 2000, endMs: 2500, clamped: true });
  });

  it('places a segment with no times after its predecessor', () => {
    const result = normalizeTimings(
      [
        { fromMs: 100, toMs: 900 },
        { fromMs: undefined, toMs: undefined },
      ],
      duration,
    );
    expect(result[1]).toEqual({ startMs: 900, endMs: 900, clamped: true });
  });
});

describe('repetition detection', () => {
  const unit = 'o dragao dorme sob a torre antiga'.split(' ');
  const copies = (n: number): string[] => Array.from({ length: n }, () => unit).flat();

  it('finds a passage repeated many times, whichever the model', () => {
    const words = ['antes', 'disso', ...copies(8), 'depois'];
    expect(findRepetitionLoops(words, REPETITION)).toEqual([{ start: 2, end: 2 + 56 }]);
  });

  it('finds the 35-word, 8-times loop S04 recorded', () => {
    const long = Array.from({ length: 35 }, (_, i) => `palavra${String(i)}`);
    const words = Array.from({ length: 8 }, () => long).flat();
    expect(findRepetitionLoops(words, REPETITION)).toEqual([{ start: 0, end: 280 }]);
  });

  it('ignores ordinary repetition in speech', () => {
    expect(findRepetitionLoops(['sim', 'sim', 'sim'], REPETITION)).toEqual([]);
    expect(findRepetitionLoops('eu acho que sim eu acho que sim'.split(' '), REPETITION)).toEqual(
      [],
    );
  });

  it('finds a one-word loop once it is long enough', () => {
    expect(findRepetitionLoops(Array<string>(12).fill('obrigado'), REPETITION)).toEqual([
      { start: 0, end: 12 },
    ]);
  });

  it('honors the configured limits', () => {
    const words = copies(3);
    expect(findRepetitionLoops(words, { ...REPETITION, minRepeats: 4 })).toEqual([]);
    expect(findRepetitionLoops(words, { ...REPETITION, maxUnitWords: 3 })).toEqual([]);
    expect(findRepetitionLoops(words, REPETITION)).toEqual([{ start: 0, end: 21 }]);
  });

  it('compares words without case or punctuation', () => {
    expect(wordsOf('O Dragão, dorme!')).toEqual(['o', 'dragão', 'dorme']);
  });
});

function fakeChunk(durationMs: number): ChunkPlanChunk {
  return {
    chunk_index: 2,
    speaker_id: 'gm',
    duration_ms: durationMs,
    flags: [],
    pieces: [
      {
        chunk_start_ms: 0,
        duration_ms: durationMs,
        fragment_id: 'gm:0',
        sample_rate_hz: 16_000,
        fragment_start_sample: 0,
        sample_length: durationMs * 16,
        fragment_start_ms: 0,
        session_start_offset_ms: 7_000,
        timing_uncertainty_ms: 40,
      },
    ],
  };
}

const RUN = '01JBX7Q8M2N4P6R8S0T2V4W6XY';

describe('buildChunkSegments', () => {
  const build = (segments: Parameters<typeof buildChunkSegments>[0]['segments']) =>
    buildChunkSegments({
      transcriptionRunId: RUN,
      chunk: fakeChunk(5_000),
      segments,
      language: 'pt',
      params,
    });

  it('computes confidence from speech tokens only, as an integer', () => {
    const [segment] = build([
      {
        fromMs: 0,
        toMs: 2000,
        text: ' texto',
        tokens: [
          { text: '<|beg|>', probability: 0.001, special: true },
          { text: ' tex', probability: 0.9, special: false },
          { text: 'to', probability: 0.8, special: false },
        ],
      },
    ]);
    expect(segment?.confidence_permille).toBe(850);
    expect(segment?.flags).toEqual([]);
    expect(segment?.text_original).toBe('texto');
  });

  it('flags one very unsure token even when the mean is fine', () => {
    const [segment] = build([
      {
        fromMs: 0,
        toMs: 2000,
        text: 'a',
        tokens: [
          { text: 'a', probability: 1, special: false },
          { text: 'b', probability: 1, special: false },
          { text: 'c', probability: 0.3, special: false },
        ],
      },
    ]);
    expect(segment?.flags).toEqual(['low_confidence']);
  });

  it('omits confidence and its flag when whisper gave no probabilities', () => {
    const [segment] = build([{ fromMs: 0, toMs: 2000, text: 'a', tokens: [] }]);
    expect(segment).not.toHaveProperty('confidence_permille');
    expect(segment?.flags).toEqual([]);
  });

  it('numbers segments consecutively, skipping empty ones', () => {
    const segments = build([
      { fromMs: 0, toMs: 1000, text: ' ', tokens: [] },
      { fromMs: 1000, toMs: 2000, text: 'b', tokens: [] },
    ]);
    expect(segments.map((s) => s.segment_id)).toEqual([`${RUN}:2:0`]);
  });

  it('propagates uncertainty and the timeline from the plan', () => {
    const [segment] = build([{ fromMs: 1000, toMs: 2000, text: 'a', tokens: [] }]);
    expect(segment).toMatchObject({
      start_offset_ms: 8_000,
      end_offset_ms: 9_000,
      timing_uncertainty_ms: 50,
    });
    expect(segment?.source_spans).toEqual([
      { fragment_id: 'gm:0', start_sample: 16_000, end_sample: 32_000 },
    ]);
  });
});

describe('flagRepetitionLoops', () => {
  it('reports loops per speaker and across chunks, keeping order', () => {
    const passage = 'um dois tres quatro cinco seis sete oito';
    const make = (speaker: string, chunk: number, text: string) => ({
      schema_version: 1 as const,
      transcription_run_id: RUN,
      segment_id: `${RUN}:${String(chunk)}:0`,
      chunk_index: chunk,
      seq: 0,
      speaker_id: speaker,
      language: 'pt',
      text_original: text,
      text_hash: `sha256:${'0'.repeat(64)}`,
      start_offset_ms: 0,
      end_offset_ms: 0,
      timing_uncertainty_ms: 0,
      chunk_start_ms: 0,
      chunk_end_ms: 0,
      source_spans: [{ fragment_id: 'gm:0', start_sample: 0, end_sample: 0 }],
      flags: [],
    });
    const input = [
      make('gm', 0, passage),
      make('ana', 1, passage),
      make('gm', 2, passage),
      make('gm', 3, passage),
    ];
    const { segments, loops } = flagRepetitionLoops(input, params);
    expect(loops).toBe(1);
    expect(segments.map((s) => s.flags.includes('repetition_loop'))).toEqual([
      true,
      false,
      true,
      true,
    ]);
    expect(segments.map((s) => s.text_original)).toEqual(input.map((s) => s.text_original));
  });
});

describe('buildWhisperPrompt', () => {
  const terms = (...spellings: string[]) =>
    spellings.map((spelling) => ({ spelling, is_english_term: false }));

  it('joins the spellings in order, without duplicates', () => {
    expect(buildWhisperPrompt(terms('Kyra', 'Sarenrae', 'Kyra'), 800)).toEqual({
      text: 'Kyra, Sarenrae',
      termsUsed: 2,
      termsDropped: 0,
    });
  });

  it('stops at the limit and counts what stayed out', () => {
    expect(buildWhisperPrompt(terms('abcd', 'efgh', 'ijkl'), 11)).toEqual({
      text: 'abcd, efgh',
      termsUsed: 2,
      termsDropped: 1,
    });
  });

  it('is empty when the glossary is empty', () => {
    expect(buildWhisperPrompt([], 800).text).toBe('');
  });
});

describe('planPromptDelivery', () => {
  const ascii = ['C:\\data\\model.bin', 'C:\\data'];

  it('uses the command line on other platforms, or for plain ASCII', () => {
    expect(planPromptDelivery('Zéfirão', ascii, 'linux')).toEqual({
      text: 'Zéfirão',
      responseFile: false,
      folded: false,
    });
    expect(planPromptDelivery('Kyra', ascii, 'win32').responseFile).toBe(false);
  });

  it('uses a response file on Windows for accented text', () => {
    expect(planPromptDelivery('Zéfirão', ascii, 'win32')).toEqual({
      text: 'Zéfirão',
      responseFile: true,
      folded: false,
    });
  });

  it('falls back to unaccented text when a path in the file would be mangled', () => {
    expect(planPromptDelivery('Zéfirão', ['C:\\Sessões\\model.bin'], 'win32')).toEqual({
      text: 'Zefirao',
      responseFile: false,
      folded: true,
    });
  });
});

describe('whisperArgs', () => {
  it('is the S04 invocation', () => {
    expect(
      whisperArgs({
        model: 'm.bin',
        wav: 'a b.wav',
        outputBase: 'out',
        language: 'pt',
        prompt: '',
      }),
    ).toEqual(['-m', 'm.bin', '-f', 'a b.wav', '-l', 'pt', '-ojf', '-of', 'out']);
  });

  it('passes a prompt as one argument', () => {
    expect(
      whisperArgs({
        model: 'm',
        wav: 'w',
        outputBase: 'o',
        language: 'pt',
        prompt: 'Kyra, "Zé" & co',
      }).slice(-2),
    ).toEqual(['--prompt', 'Kyra, "Zé" & co']);
  });
});

describe('asr parameters', () => {
  it('merges overrides over the provisional defaults', () => {
    expect(resolveAsrParams({ short_segment_ms: 500 }).short_segment_ms).toBe(500);
    expect(resolveAsrParams().prompt_max_chars).toBe(800);
  });

  it('keeps timeouts out of what changes a run', () => {
    expect(asrOutputParams(params)).not.toHaveProperty('timeout_base_ms');
    expect(asrOutputParams(params)).not.toHaveProperty('timeout_audio_multiplier');
  });

  it('reduces a campaign language to whisper’s code', () => {
    expect(whisperLanguage('pt-BR')).toBe('pt');
    expect(whisperLanguage('pt')).toBe('pt');
  });
});

describe('writeChunkWav', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'recap-chunk-audio-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  function pcm16k(ms: number, sampleOf: (sample: number) => number): string {
    const data = Buffer.alloc(ms * 16 * 2);
    for (let i = 0; i < ms * 16; i += 1) data.writeInt16LE(sampleOf(i), i * 2);
    const header = Buffer.alloc(44);
    header.write('RIFF', 0, 'latin1');
    header.writeUInt32LE(36 + data.length, 4);
    header.write('WAVE', 8, 'latin1');
    header.write('fmt ', 12, 'latin1');
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(16_000, 24);
    header.writeUInt32LE(32_000, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36, 'latin1');
    header.writeUInt32LE(data.length, 40);
    const file = path.join(dir, 'decoded.wav');
    writeFileSync(file, Buffer.concat([header, data]));
    return file;
  }

  const samplesOf = (file: string): number[] => {
    const bytes = readFileSync(file);
    const samples: number[] = [];
    for (let i = 44; i + 1 < bytes.length; i += 2) samples.push(bytes.readInt16LE(i));
    return samples;
  };

  it('cuts each piece to exactly its duration, so the T08 map holds', async () => {
    const decoded = pcm16k(2_000, (i) => (i % 30_000) - 15_000);
    const target = path.join(dir, 'chunk.wav');
    await writeChunkWav(target, [
      { file: decoded, startMs: 500, durationMs: 700 },
      { file: decoded, startMs: 1_500, durationMs: 500 },
    ]);
    const samples = samplesOf(target);
    expect(samples).toHaveLength((700 + 500) * 16);
    expect(samples[0]).toBe(500 * 16 - 15_000);
    expect(samples[700 * 16 - 1]).toBe(1_200 * 16 - 1 - 15_000);
    expect(samples[700 * 16]).toBe(1_500 * 16 - 15_000);
    expect(readFileSync(target).readUInt32LE(40)).toBe(samples.length * 2);
  });

  it('pads a short chunk with silence after the audio, not before', async () => {
    const decoded = pcm16k(100, () => 1234);
    const target = path.join(dir, 'chunk.wav');
    await writeChunkWav(target, [{ file: decoded, startMs: 0, durationMs: 100 }]);
    const samples = samplesOf(target);
    expect(samples).toHaveLength(MIN_WHISPER_AUDIO_MS * 16);
    expect(samples[100 * 16 - 1]).toBe(1234);
    expect(samples[100 * 16]).toBe(0);
  });

  it('pads a slightly short decode and refuses a much shorter one', async () => {
    const decoded = pcm16k(2_000, () => 1);
    const target = path.join(dir, 'chunk.wav');
    await writeChunkWav(target, [{ file: decoded, startMs: 0, durationMs: 2_000 + 100 }]);
    expect(samplesOf(target)).toHaveLength(2_100 * 16);
    await expect(
      writeChunkWav(path.join(dir, 'chunk2.wav'), [
        { file: decoded, startMs: 0, durationMs: 2_000 + MAX_DECODE_SHORTFALL_MS + 1 },
      ]),
    ).rejects.toMatchObject({ code: 'chunk-audio-short' });
  });
});
