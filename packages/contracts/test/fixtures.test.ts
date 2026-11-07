import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONTRACT_NAMES, formatIssues, validateContract } from '../src/index.ts';
import { FIXTURES_DIR, readJson } from './helpers.ts';

interface ExpectedIssue {
  path: string;
  keyword: string;
}

describe('contract fixtures', () => {
  it('has a fixture directory for every contract and no orphan directories', () => {
    const dirs = readdirSync(FIXTURES_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    expect(dirs).toEqual([...CONTRACT_NAMES].sort());
  });

  describe.each(CONTRACT_NAMES)('%s', (name) => {
    const dir = join(FIXTURES_DIR, name);
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
    const valid = files.filter((f) => f.startsWith('valid'));
    const invalid = files.filter((f) => f.startsWith('invalid'));
    const expectedPath = join(dir, 'expected-errors.json');
    const expected = (existsSync(expectedPath) ? readJson(expectedPath) : {}) as Record<
      string,
      ExpectedIssue[]
    >;

    it('has at least one valid and one invalid fixture', () => {
      expect(valid.length).toBeGreaterThan(0);
      expect(invalid.length).toBeGreaterThan(0);
    });

    it('lists expected errors for exactly the invalid fixtures', () => {
      expect(Object.keys(expected).sort()).toEqual([...invalid].sort());
    });

    it.each(valid)('accepts %s', (file) => {
      const result = validateContract(name, readJson(join(dir, file)));
      expect(result.ok ? '' : formatIssues(result.errors, file)).toBe('');
    });

    it.each(invalid)('rejects %s for the expected reason', (file) => {
      const result = validateContract(name, readJson(join(dir, file)));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      for (const issue of result.errors) {
        expect(issue.path).toMatch(/^(\/[^/]*)*$/);
        expect(issue.message.length).toBeGreaterThan(0);
      }
      const actual = result.errors.map((e) => ({ path: e.path, keyword: e.keyword }));
      for (const want of expected[file] ?? []) expect(actual).toContainEqual(want);
    });
  });
});
