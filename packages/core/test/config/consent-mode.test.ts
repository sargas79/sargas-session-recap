import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildProgram } from '../../src/cli/program.ts';
import { assertConsent } from '../../src/config/consent.ts';
import { readConsentMode, setConsentMode } from '../../src/config/consent-mode.ts';
import { isConfigError } from '../../src/config/errors.ts';
import { loadCampaignConfig } from '../../src/config/load.ts';
import { campaignText } from './helpers.ts';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'recap consent ação '));
  file = join(dir, 'campaign.yaml');
  writeFileSync(file, campaignText());
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('setConsentMode', () => {
  it('turns record checks off and on again, keeping comments', async () => {
    const original = readFileSync(file, 'utf8');
    const comments = original.split('\n').filter((l) => l.trimStart().startsWith('#'));
    expect(comments.length).toBeGreaterThan(0);

    const off = await setConsentMode(file, 'implied');
    expect(off).toMatchObject({ previous: 'records', mode: 'implied', changed: true });
    expect(await readConsentMode(file)).toBe('implied');
    const text = readFileSync(file, 'utf8');
    for (const c of comments) expect(text).toContain(c.trim());
    // Placed right after `language` for readability.
    expect(text).toMatch(/^language: .*\n(?:#.*\n)*consent_mode: implied$/m);

    const on = await setConsentMode(file, 'records');
    expect(on).toMatchObject({ previous: 'implied', mode: 'records', changed: true });
    expect(await readConsentMode(file)).toBe('records');
  });

  it('lets a speaker without consent records through once turned off', async () => {
    await setConsentMode(file, 'implied');
    const { value } = await loadCampaignConfig(file);
    expect(() =>
      assertConsent({
        campaign: value,
        speakerIds: ['player-bruno'],
        provider: value.provider.classification,
        stage: 'classification',
        now: new Date('2026-03-15T12:00:00Z'),
      }),
    ).not.toThrow();
  });

  it('reads a campaign.yaml without consent_mode as implied (record checks off)', async () => {
    writeFileSync(file, campaignText().replace(/^consent_mode: .*\r?\n/m, ''));
    expect(readFileSync(file, 'utf8')).not.toMatch(/^consent_mode:/m);
    expect(await readConsentMode(file)).toBe('implied');
  });

  it('does not rewrite the file when the mode is already set', async () => {
    await setConsentMode(file, 'implied');
    const before = readFileSync(file, 'utf8');
    const again = await setConsentMode(file, 'implied');
    expect(again.changed).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('keeps a UTF-8 BOM and CRLF line endings', async () => {
    writeFileSync(file, '﻿' + campaignText().replace(/\r?\n/g, '\r\n'));
    await setConsentMode(file, 'implied');
    const text = readFileSync(file, 'utf8');
    expect(text.startsWith('﻿')).toBe(true);
    expect(text.replace(/\r\n/g, '')).not.toContain('\n');
    expect(await readConsentMode(file)).toBe('implied');
  });

  it('refuses to touch an invalid file', async () => {
    const broken = campaignText().replace(/^language: .*$/m, 'language: [');
    writeFileSync(file, broken);
    await expect(setConsentMode(file, 'implied')).rejects.toSatisfy(isConfigError);
    expect(readFileSync(file, 'utf8')).toBe(broken);
  });
});

describe('recap config consent', () => {
  async function run(...args: string[]): Promise<{ out: string; err: string; code: number }> {
    let out = '';
    let err = '';
    const previous = process.exitCode;
    process.exitCode = 0;
    const program = buildProgram({ out: (t) => (out += t), err: (t) => (err += t) });
    program.exitOverride();
    await program.parseAsync(['node', 'recap', ...args]);
    const code = process.exitCode;
    process.exitCode = previous;
    return { out, err, code };
  }

  it('off, status and on', async () => {
    expect((await run('config', 'consent', 'status', file)).out).toContain('consent: on');
    const off = await run('config', 'consent', 'off', file);
    expect(off.code).toBe(0);
    expect(off.out).toContain('consent: off (implied)');
    expect((await run('config', 'consent', 'status', file)).out).toContain('consent: off');
    expect((await run('config', 'consent', 'on', file)).out).toContain('consent: on (records)');
  });

  it('rejects an unknown state without echoing it', async () => {
    const r = await run('config', 'consent', 'maybe-SECRET', file);
    expect(r.code).toBe(2);
    expect(r.err).not.toContain('SECRET');
  });
});
