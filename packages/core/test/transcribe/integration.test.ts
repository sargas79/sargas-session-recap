/**
 * Pause detection and planning against a real ffmpeg, on synthetic audio generated at test time
 * (sine and silence from `lavfi`); no audio is committed. Skipped locally when ffmpeg is missing;
 * in CI (`CI` set) a missing ffmpeg is a failure, as in test/audio/integration.test.ts.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Fragment } from '@sargas-recap/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AudioToolError,
  resolveAudioToolchain,
  runTool,
  type AudioToolchain,
} from '../../src/audio/index.ts';
import {
  chunkToSource,
  detectFragmentPauses,
  planChunks,
  resolveChunkPlanParams,
} from '../../src/transcribe/index.ts';
import { fragmentOf } from './helpers.ts';

const toolchain: AudioToolchain | AudioToolError = await resolveAudioToolchain().catch(
  (error: unknown) => {
    if (error instanceof AudioToolError) return error;
    throw error;
  },
);
const tools = toolchain instanceof AudioToolError ? undefined : toolchain;
const inCi = (process.env['CI'] ?? '') !== '';
const SKIP_LABEL = tools === undefined ? ' (SKIPPED: ffmpeg/ffprobe not found)' : '';

describe.runIf(tools === undefined && inCi)('chunk-plan integration prerequisites (CI)', () => {
  it('has ffmpeg and ffprobe installed by the workflow', () => {
    expect.fail('ffmpeg/ffprobe must be available in CI');
  });
});

describe.skipIf(tools === undefined)(`chunk planning with real ffmpeg${SKIP_LABEL}`, () => {
  let root: string;
  let fragment: Fragment;

  beforeAll(async () => {
    if (tools === undefined) return;
    root = mkdtempSync(path.join(tmpdir(), 'recap-chunk-'));
    mkdirSync(path.join(root, 'audio', 'gm'), { recursive: true });
    const file = path.join(root, 'audio', 'gm', '0.wav');
    // 2 s tone, 3 s silence, 1 s tone, at 16 kHz.
    const result = await runTool(
      tools.ffmpeg.path,
      [
        '-hide_banner',
        '-nostdin',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'aevalsrc=exprs=0.5*sin(2*PI*440*t)*(lt(t\\,2)+gte(t\\,5)):s=16000:d=6',
        '-c:a',
        'pcm_s16le',
        file,
      ],
      { tool: 'ffmpeg', timeoutMs: 60_000 },
    );
    expect(result.exitCode).toBe(0);
    fragment = fragmentOf('gm:0', 6000, 1000, { path: 'audio/gm/0.wav', codec: 'pcm_s16le' });
  });

  afterAll(() => {
    if (tools !== undefined) rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  });

  it('removes the silence and keeps the map exact around it', async () => {
    if (tools === undefined) return;
    const params = resolveChunkPlanParams();
    const pauses = await detectFragmentPauses(root, [fragment], params, { ffmpeg: tools.ffmpeg });
    const detected = pauses.get('gm:0') ?? [];
    expect(detected).toHaveLength(1);
    expect(Math.abs((detected[0]?.startMs ?? 0) - 2000)).toBeLessThanOrEqual(30);
    expect(Math.abs((detected[0]?.endMs ?? 0) - 5000)).toBeLessThanOrEqual(30);

    const plan = planChunks({ fragments: [fragment], pauses, params });
    expect(plan.pauses[0]?.disposition).toBe('removed');
    const chunk = plan.chunks[0];
    if (chunk === undefined) throw new Error('no chunk');
    expect(chunk.pieces).toHaveLength(2);
    expect(chunk.duration_ms).toBeLessThan(6000);

    const junction = chunk.pieces[1]?.chunk_start_ms ?? 0;
    const mapped = chunkToSource(chunk, junction);
    expect(mapped.atJunction).toBe(true);
    expect(mapped.sessionOffsetMs).toBe(1000 + (chunk.pieces[1]?.fragment_start_ms ?? 0));
    expect(mapped.timingUncertaintyMs).toBeGreaterThan(0);
  });
});
