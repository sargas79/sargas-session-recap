import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newUlid, probeWavHeader } from '../../src/capture/index.ts';
import { ULID_PATTERN } from '@sargas-recap/contracts';
import { wavBytes } from './helpers.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'recap-wav-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, data: Buffer): string {
  const file = path.join(dir, name);
  writeFileSync(file, data);
  return file;
}

/** Inserts a chunk between `fmt ` and `data` of a 44-byte-header WAV. */
function withChunk(wav: Buffer, id: string, body: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(id, 0, 'latin1');
  header.writeUInt32LE(body.length, 4);
  const pad = body.length % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0);
  const out = Buffer.concat([wav.subarray(0, 36), header, body, pad, wav.subarray(36)]);
  out.writeUInt32LE(out.length - 8, 4);
  return out;
}

describe('probeWavHeader', () => {
  it('reads mono and stereo 16-bit PCM headers exactly', async () => {
    await expect(
      probeWavHeader(write('a.wav', wavBytes({ rate: 8000, samples: 8000 }))),
    ).resolves.toEqual({
      codec: 'pcm_s16le',
      sampleRate: 8000,
      channels: 1,
      sampleCount: 8000,
      durationMs: 1000,
    });
    await expect(
      probeWavHeader(
        write('b.wav', wavBytes({ rate: 48000, channels: 2, samples: 1000, kind: 'silence' })),
      ),
    ).resolves.toEqual({
      codec: 'pcm_s16le',
      sampleRate: 48000,
      channels: 2,
      sampleCount: 1000,
      durationMs: 21, // rounded, like probeAudio
    });
  });

  it('skips odd-sized chunks before the data chunk', async () => {
    const wav = withChunk(wavBytes({ samples: 400 }), 'LIST', Buffer.from('odd'));
    await expect(probeWavHeader(write('c.wav', wav))).resolves.toMatchObject({
      sampleCount: 400,
    });
  });

  it('uses the bytes on disk when a streaming writer never patched the data size', async () => {
    const wav = wavBytes({ samples: 400 });
    wav.writeUInt32LE(0xffffffff, 40);
    await expect(probeWavHeader(write('d.wav', wav))).resolves.toMatchObject({
      sampleCount: 400,
    });
  });

  it('accepts WAVE_FORMAT_EXTENSIBLE with the PCM sub-format', async () => {
    const pcm = wavBytes({ samples: 100, channels: 2 });
    const fmt = Buffer.alloc(40);
    pcm.copy(fmt, 0, 20, 36);
    fmt.writeUInt16LE(0xfffe, 0);
    fmt.writeUInt16LE(22, 16);
    fmt.writeUInt16LE(16, 18);
    fmt.writeUInt32LE(3, 20);
    Buffer.from('0100000000001000800000aa00389b71', 'hex').copy(fmt, 24);
    const header = Buffer.from('RIFF\0\0\0\0WAVEfmt (\0\0\0', 'latin1');
    const out = Buffer.concat([header, fmt, pcm.subarray(36)]);
    out.writeUInt32LE(out.length - 8, 4);
    await expect(probeWavHeader(write('e.wav', out))).resolves.toMatchObject({
      codec: 'pcm_s16le',
      channels: 2,
      sampleCount: 100,
    });
  });

  it('returns undefined for anything that is not 16-bit PCM WAV (ffprobe decides)', async () => {
    const float = wavBytes({ samples: 10 });
    float.writeUInt16LE(3, 20);
    const bits24 = wavBytes({ samples: 10 });
    bits24.writeUInt16LE(24, 34);
    const rf64 = wavBytes({ samples: 10 });
    rf64.write('RF64', 0, 'latin1');
    for (const [name, data] of [
      ['float.wav', float],
      ['24.wav', bits24],
      ['rf64.wav', rf64],
      ['text.wav', Buffer.from('not a wav at all')],
      ['empty.wav', Buffer.alloc(0)],
    ] as const) {
      await expect(probeWavHeader(write(name, data))).resolves.toBeUndefined();
    }
  });
});

describe('newUlid', () => {
  it('produces ADR-004 ULIDs with the timestamp prefix', () => {
    const id = newUlid(0x0123456789ab, new Uint8Array(10));
    expect(id).toMatch(new RegExp(ULID_PATTERN));
    expect(id).toBe('014D2PF2DB0000000000000000');
    expect(newUlid()).toMatch(new RegExp(ULID_PATTERN));
    expect(newUlid(Date.now(), new Uint8Array(10).fill(255)).endsWith('ZZZZZZZZZZZZZZZZ')).toBe(
      true,
    );
  });

  it('rejects out-of-range input', () => {
    expect(() => newUlid(-1)).toThrow(RangeError);
    expect(() => newUlid(1, new Uint8Array(3))).toThrow(RangeError);
  });
});
