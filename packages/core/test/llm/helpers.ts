import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CampaignConfig, ClassificationResult, Recap } from '@sargas-recap/contracts';
import { createLlmBackend, type LlmBackend, type LlmBackendOptions } from '../../src/llm/index.ts';
import { createLogger } from '../../src/log/index.ts';
import { loadPromptRegistry, type PromptAsset } from '../../src/prompts/index.ts';
import { campaign } from '../config/helpers.ts';

export const FAKE_CLAUDE = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url));
const CONTRACTS = new URL('../../../../fixtures/contracts/', import.meta.url);

function contractFixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`${name}/valid.json`, CONTRACTS), 'utf8'));
}

export const validClassification = (): ClassificationResult =>
  contractFixture('classification-result') as ClassificationResult;
export const validRecap = (): Recap => contractFixture('recap') as Recap;

export const probes = (): string[] =>
  (
    JSON.parse(
      readFileSync(
        new URL('../../../../fixtures/llm/injection-probes.json', import.meta.url),
        'utf8',
      ),
    ) as { probes: string[] }
  ).probes;

export function llmCampaign(provider = 'claude-cli'): CampaignConfig {
  const config = campaign();
  config.provider.classification = provider;
  config.provider.recap = provider;
  config.llm_model = { classification: 'model-for-classify', recap: 'model-for-recap' };
  config.consent_mode = 'implied';
  return config;
}

export const speakerIds = (config: CampaignConfig): string[] =>
  config.speakers.map((s) => s.speaker_id);

const registry = loadPromptRegistry();
export const prompts = registry;
export const classifyPrompt = (): PromptAsset => registry.latest('classification.window');
export const recapPrompt = (): PromptAsset => registry.latest('recap.draft');

export const TRANSCRIPT = 'SYNTHETIC-TRANSCRIPT-LINE the party opens the door';

export interface FakeRun {
  readonly dir: string;
  readonly recordFile: string;
  readonly counterFile: string;
  readonly pidFile: string;
  readonly logLines: string[];
  backend(overrides?: Partial<LlmBackendOptions>, env?: Record<string, string>): LlmBackend;
  record(): { args: string[]; cwd: string; stdin: string; envNames: string[] };
  invocations(): number;
  cleanup(): void;
}

/** A backend wired to the fake CLI, scripted through `modes`. */
export function fakeRun(modes: string, output: unknown = {}, config = llmCampaign()): FakeRun {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'recap-llm-test-'));
  const recordFile = path.join(dir, 'record.json');
  const counterFile = path.join(dir, 'counter');
  const pidFile = path.join(dir, 'pid');
  const logLines: string[] = [];
  return {
    dir,
    recordFile,
    counterFile,
    pidFile,
    logLines,
    backend: (overrides = {}, env = {}) =>
      createLlmBackend({
        campaign: config,
        prompts,
        retry: { baseDelayMs: 1, maxDelayMs: 1 },
        logger: createLogger({ sink: (line) => logLines.push(line) }),
        ...overrides,
        claudeCode: {
          command: process.execPath,
          prefixArgs: [FAKE_CLAUDE],
          extraEnv: {
            FAKE_CLAUDE_MODES: modes,
            FAKE_CLAUDE_COUNTER: counterFile,
            FAKE_CLAUDE_RECORD: recordFile,
            FAKE_CLAUDE_PID_FILE: pidFile,
            FAKE_CLAUDE_OUTPUT: JSON.stringify(output),
            ...env,
          },
          ...overrides.claudeCode,
        },
      }),
    record: () => JSON.parse(readFileSync(recordFile, 'utf8')) as ReturnType<FakeRun['record']>,
    invocations: () => Number(readFileSync(counterFile, 'utf8')),
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}
