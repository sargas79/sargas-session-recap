import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ConfigError,
  loadCampaignConfig,
  loadGlossary,
  parseCampaignConfig,
  parseGlossary,
} from '../../src/config/index.ts';
import { CAMPAIGN_FILE, GLOSSARY_FILE, campaignText, glossaryText } from './helpers.ts';

const tmp = mkdtempSync(join(tmpdir(), 'recap-config-'));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function configError(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (err) {
    if (err instanceof ConfigError) return err;
    throw err;
  }
  throw new Error('expected a ConfigError');
}

const SECRET = 'SECRET-private-value';

describe('loading the synthetic fixtures', () => {
  it('loads campaign.yaml and glossary.yaml from disk', async () => {
    const c = await loadCampaignConfig(CAMPAIGN_FILE);
    expect(c.kind).toBe('campaign-config');
    expect(c.value.campaign_id).toBe('synthetic-vaults');
    expect(c.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    const g = await loadGlossary(GLOSSARY_FILE);
    expect(g.value.entries.map((e) => e.id)).toEqual(['kyra', 'sarenrae', 'flat-footed', 'otari']);
  });

  it('accepts a UTF-8 BOM and CRLF line endings with the same hash', () => {
    const plain = parseGlossary(glossaryText());
    const windows = parseGlossary(`\uFEFF${glossaryText().replace(/\n/g, '\r\n')}`);
    expect(windows.hash).toBe(plain.hash);
  });

  it('hash ignores comments, formatting and key order', () => {
    const a = parseGlossary('schema_version: 1\nentries:\n  - {id: a, spelling: A, type: npc}\n');
    const b = parseGlossary(
      '# comment\nentries:\n  - type: npc\n    spelling: "A"\n    id: a\nschema_version: 1\n',
    );
    expect(b.hash).toBe(a.hash);
  });
});

describe('safe YAML', () => {
  const cases: [string, string, string][] = [
    ['duplicate keys', `schema_version: 1\nentries: []\nentries: []\n`, 'yaml:DUPLICATE_KEY'],
    ['custom tags', `schema_version: 1\nentries: !secret ${SECRET}\n`, 'yaml:TAG_RESOLVE_FAILED'],
    [
      'js tags',
      `schema_version: 1\nentries: !!js/function "${SECRET}"\n`,
      'yaml:TAG_RESOLVE_FAILED',
    ],
    ['core tags', `schema_version: !!int 1\nentries: []\n`, 'yaml:tag'],
    ['binary tags', `schema_version: 1\nx: !!binary aGVsbG8=\nentries: []\n`, 'yaml:tag'],
    ['aliases', `a: &x ${SECRET}\nentries: [*x]\nschema_version: 1\n`, 'yaml:anchor'],
    ['merge keys', `base: &b {id: a}\nentries:\n  - <<: *b\nschema_version: 1\n`, 'yaml:anchor'],
    ['multiple documents', `schema_version: 1\n---\nentries: []\n`, 'yaml:MULTIPLE_DOCS'],
    ['non-string keys', `schema_version: 1\nentries: []\n? [a, b]\n: 1\n`, 'yaml:key'],
    ['syntax errors', `schema_version: 1\nentries: [${SECRET}\n`, 'yaml:BAD_INDENT'],
  ];

  it.each(cases)('rejects %s without echoing source text', (_label, text, keyword) => {
    const err = configError(() => parseGlossary(text, 'glossary.yaml'));
    expect(['CONFIG_YAML_SYNTAX', 'CONFIG_YAML_FORBIDDEN']).toContain(err.code);
    expect(err.issues.map((i) => i.keyword)).toContain(keyword);
    expect(err.issues.every((i) => typeof i.line === 'number')).toBe(true);
    expect(`${err.message}${JSON.stringify(err.issues)}`).not.toContain('SECRET');
    expect(err.message).toContain('glossary.yaml:');
  });

  it('rejects text over the size limit', () => {
    const err = configError(() => parseGlossary(glossaryText(), 'g.yaml', { maxBytes: 64 }));
    expect(err.code).toBe('CONFIG_TOO_LARGE');
  });

  it('rejects files over the size limit before reading them', async () => {
    const file = join(tmp, 'big.yaml');
    writeFileSync(file, `# ${'x'.repeat(2048)}\nschema_version: 1\nentries: []\n`);
    await expect(loadGlossary(file, { maxBytes: 1024 })).rejects.toMatchObject({
      code: 'CONFIG_TOO_LARGE',
    });
  });

  it('rejects invalid UTF-8', async () => {
    const file = join(tmp, 'latin1.yaml');
    writeFileSync(file, Buffer.from([0x61, 0x3a, 0x20, 0xe9, 0x0a]));
    await expect(loadGlossary(file)).rejects.toMatchObject({ code: 'CONFIG_NOT_UTF8' });
  });

  it('reports a missing file actionably', async () => {
    const file = join(tmp, 'missing.yaml');
    const err = await loadCampaignConfig(file).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).code).toBe('CONFIG_READ_FAILED');
    expect((err as ConfigError).message).toContain(file);
    expect((err as ConfigError).message).toContain('file not found');
  });

  it('does not pollute prototypes', () => {
    const err = configError(() =>
      parseGlossary('__proto__: {polluted: true}\nschema_version: 1\nentries: []\n'),
    );
    expect(err.code).toBe('CONFIG_INVALID');
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});

describe('glossary validation', () => {
  it('rejects duplicate IDs with both paths and the line', () => {
    const text = glossaryText().replace('id: otari', 'id: kyra');
    const err = configError(() => parseGlossary(text, 'glossary.yaml'));
    expect(err.code).toBe('CONFIG_INVALID');
    expect(err.issues).toEqual([
      expect.objectContaining({
        path: '/entries/3/id',
        keyword: 'unique',
        message: 'duplicates /entries/0/id',
        line: 17,
      }),
    ]);
  });

  it('rejects unknown types, naming file, path and line but not the value', () => {
    const text = glossaryText().replace('type: deity', 'type: SECRET-goddess');
    const err = configError(() => parseGlossary(text, 'D:\\data\\glossary.yaml'));
    expect(err.issues).toEqual([
      expect.objectContaining({ path: '/entries/1/type', keyword: 'enum', line: 10, col: 11 }),
    ]);
    expect(err.message).toContain('D:\\data\\glossary.yaml:10:11: /entries/1/type: must be one of');
    expect(err.message).not.toContain('SECRET');
  });

  it('masks unknown keys', () => {
    const text = glossaryText().replace('    type: pc\n', `    type: pc\n    ${SECRET}: 1\n`);
    const err = configError(() => parseGlossary(text));
    expect(err.issues).toContainEqual(
      expect.objectContaining({ path: '/entries/0/<key>', keyword: 'additionalProperties' }),
    );
    expect(JSON.stringify(err.issues) + err.message).not.toContain('SECRET');
  });
});

describe('campaign validation', () => {
  it('rejects duplicate speaker IDs', () => {
    const text = campaignText().replace('speaker_id: player-bruno', 'speaker_id: player-ana');
    const err = configError(() => parseCampaignConfig(text));
    expect(err.issues).toContainEqual(
      expect.objectContaining({ path: '/speakers/2/speaker_id', keyword: 'unique' }),
    );
  });

  it('rejects a withdrawal before the grant', () => {
    const text = campaignText().replace('withdrawn_on: 2026-02-01', 'withdrawn_on: 2025-12-31');
    const err = configError(() => parseCampaignConfig(text));
    expect(err.issues).toEqual([
      expect.objectContaining({ path: '/speakers/2/consent/2/withdrawn_on', keyword: 'order' }),
    ]);
  });

  it('rejects a consent record without a provider and an unknown stage provider key', () => {
    const text = campaignText()
      .replace(
        '{ purpose: recap, provider: claude-cli, granted_on: 2026-01-10 }',
        '{ purpose: recap, granted_on: 2026-01-10 }',
      )
      .replace('  recap: claude-cli\n', '  recap: claude-cli\n  summarizer: other\n');
    const err = configError(() => parseCampaignConfig(text, 'campaign.yaml'));
    expect(err.code).toBe('CONFIG_INVALID');
    const got = err.issues.map((i) => [i.path, i.keyword]);
    expect(got).toContainEqual(['/speakers/0/consent/3/provider', 'required']);
    expect(got).toContainEqual(['/provider/<key>', 'additionalProperties']);
    expect(err.message.split('\n')[0]).toBe(
      'invalid campaign-config file campaign.yaml (2 problems)',
    );
  });

  it('rejects unquoted non-date consent dates', () => {
    const text = campaignText().replace('granted_on: 2026-01-10 }', 'granted_on: 10/01/2026 }');
    const err = configError(() => parseCampaignConfig(text));
    expect(err.issues).toContainEqual(
      expect.objectContaining({ path: '/speakers/0/consent/0/granted_on', keyword: 'format' }),
    );
  });
});
