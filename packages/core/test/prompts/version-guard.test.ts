/**
 * Version-bump guard (T26). `prompt-hashes.json` freezes the content hash of every committed prompt
 * version. Editing a committed prompt file without a version bump changes its hash and fails here.
 *
 * To change a prompt: copy `<name>.v<N>.md` to `<name>.v<N+1>.md`, set `version: N+1`, edit the
 * copy, and add the new `<id>@v<N+1>` line (the hash this test prints) to prompt-hashes.json. Never
 * change an existing line.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  createPromptRegistry,
  loadPromptRegistry,
  parsePromptAsset,
  promptKey,
  type PromptAsset,
} from '../../src/prompts/index.ts';
import { promptText } from './helpers.ts';

const SNAPSHOT_URL = new URL('./prompt-hashes.json', import.meta.url);

function readSnapshot(): Record<string, string> {
  return JSON.parse(readFileSync(SNAPSHOT_URL, 'utf8')) as Record<string, string>;
}

/** Problems between the loaded prompts and the frozen snapshot; empty when they agree. */
function checkSnapshot(
  assets: readonly PromptAsset[],
  snapshot: Readonly<Record<string, string>>,
): string[] {
  const problems: string[] = [];
  const keys = new Set<string>();
  for (const asset of assets) {
    const key = promptKey(asset);
    keys.add(key);
    const frozen = snapshot[key];
    if (frozen === undefined) {
      problems.push(
        `new prompt version ${key} (${asset.file}): add "${key}": "${asset.hash}" to test/prompts/prompt-hashes.json`,
      );
    } else if (frozen !== asset.hash) {
      problems.push(
        `prompt ${key} (${asset.file}) changed without a version bump (frozen ${frozen}, now ${asset.hash}): revert it and put the edit in v${String(asset.version + 1)}`,
      );
    }
  }
  for (const key of Object.keys(snapshot)) {
    if (!keys.has(key)) {
      problems.push(
        `prompt ${key} is in prompt-hashes.json but its file is gone: committed prompt versions are kept so old runs stay reproducible`,
      );
    }
  }
  return problems;
}

describe('prompt version-bump guard', () => {
  it('every committed prompt matches its frozen hash in prompt-hashes.json', () => {
    expect(checkSnapshot(loadPromptRegistry().list(), readSnapshot())).toEqual([]);
  });

  it('the snapshot is sorted and holds only <id>@v<N> -> sha256 entries', () => {
    const snapshot = readSnapshot();
    const keys = Object.keys(snapshot);
    expect(keys).toEqual([...keys].sort());
    for (const [key, hash] of Object.entries(snapshot)) {
      expect(key).toMatch(/^[a-z]+\.[a-z0-9-]+@v[1-9][0-9]*$/);
      expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  describe('catches', () => {
    const v1 = parsePromptAsset('recap/draft.v1.md', promptText('recap', 'draft', 1));
    const snapshot = { 'recap.draft@v1': v1.hash };

    it('an in-place edit without a version bump', () => {
      const edited = parsePromptAsset(
        'recap/draft.v1.md',
        promptText('recap', 'draft', 1, 'Edited.\n\n{{data:transcript}}\n'),
      );
      const problems = checkSnapshot(createPromptRegistry([edited]).list(), snapshot);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/recap\.draft@v1 .* changed without a version bump/);
    });

    it('a new version not yet recorded, and accepts it once recorded', () => {
      const v2 = parsePromptAsset(
        'recap/draft.v2.md',
        promptText('recap', 'draft', 2, 'Edited.\n\n{{data:transcript}}\n'),
      );
      const assets = createPromptRegistry([v1, v2]).list();
      expect(checkSnapshot(assets, snapshot)).toEqual([
        expect.stringMatching(/new prompt version recap\.draft@v2/),
      ]);
      expect(checkSnapshot(assets, { ...snapshot, 'recap.draft@v2': v2.hash })).toEqual([]);
    });

    it('a deleted committed version', () => {
      expect(checkSnapshot([], snapshot)).toEqual([
        expect.stringMatching(/recap\.draft@v1 is in prompt-hashes\.json but its file is gone/),
      ]);
    });

    it('but not a line-ending-only change', () => {
      const crlf = parsePromptAsset(
        'recap/draft.v1.md',
        promptText('recap', 'draft', 1).replace(/\n/g, '\r\n'),
      );
      expect(checkSnapshot([crlf], snapshot)).toEqual([]);
    });
  });
});
