/**
 * The narrow LLM backend (T10): `classify` and `writeRecap`, each returning contract-validated JSON.
 *
 * Which adapter runs is decided by campaign.yaml (`provider.<stage>`, `llm_model.<stage>`). Every
 * attempt first passes `assertConsent()`, then renders the prompt with a fresh nonce, so transcript
 * text only ever travels inside the prompt's untrusted-data block.
 *
 * Retries live here and are bounded by `retry.maxAttempts`, across which usage is summed. The error
 * that finally escapes is non-retryable even for a transient cause: the T07 runner would otherwise
 * multiply the budget (3 x 3 calls, each up to the timeout).
 */
import {
  formatIssues,
  validateContract,
  type CampaignConfig,
  type ClassificationModelResult,
  type Recap,
  type ValidationIssue,
} from '@sargas-recap/contracts';
import { assertConsent } from '../config/consent.ts';
import { abortableSleep } from '../jobs/runner.ts';
import { backoffDelay, DEFAULT_RETRY, type RetryPolicy } from '../jobs/stage.ts';
import type { JobUsage } from '../jobs/store.ts';
import { createLogger, secretRedactor, type Logger } from '../log/index.ts';
import {
  renderPrompt,
  type PromptAsset,
  type PromptRef,
  type PromptRegistry,
  type PromptStage,
} from '../prompts/index.ts';
import { addUsage, type LlmAdapter } from './adapter.ts';
import { createClaudeApiAdapter, type ClaudeApiOptions } from './claude-api.ts';
import { createClaudeCodeAdapter, type ClaudeCodeOptions } from './claude-code.ts';
import { isLlmError, LlmError } from './errors.ts';
import { modelSchema } from './output-schema.ts';

export const LLM_PROVIDERS = ['claude-cli', 'claude-api'] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

const DEFAULT_TIMEOUT_MS = 600_000;

export interface LlmCall<T> {
  /** The task prompt, from the prompt registry. */
  readonly prompt: PromptAsset;
  /** Untrusted values for the prompt's declared data slots. */
  readonly data: Readonly<Record<string, string>>;
  /** Every speaker whose text is in `data`; the consent check covers exactly these. */
  readonly speakerIds: readonly string[];
  readonly signal?: AbortSignal | undefined;
  /**
   * Checks beyond the contract, such as unknown segment IDs. Returned problems fail the attempt and
   * count against the retry budget. They must not quote transcript text.
   */
  readonly validate?: ((output: T) => readonly string[]) | undefined;
}

export interface LlmResult<T> {
  readonly output: T;
  /** Summed over every attempt that reported usage; goes into `StageResult.usage`. */
  readonly usage: JobUsage;
  readonly provider: LlmProvider;
  readonly model: string;
  readonly attempts: number;
  /** The task and system prompts used. */
  readonly prompts: readonly PromptRef[];
}

export interface LlmBackend {
  /** Returns what the model can know; the classify stage (T11) completes the records. */
  classify(
    call: LlmCall<ClassificationModelResult[]>,
  ): Promise<LlmResult<ClassificationModelResult[]>>;
  writeRecap(call: LlmCall<Recap>): Promise<LlmResult<Recap>>;
}

export interface LlmBackendOptions {
  readonly campaign: CampaignConfig;
  readonly prompts: PromptRegistry;
  readonly timeoutMs?: number | undefined;
  readonly retry?: Partial<RetryPolicy> | undefined;
  readonly logger?: Logger | undefined;
  readonly claudeCode?: ClaudeCodeOptions | undefined;
  readonly claudeApi?: ClaudeApiOptions | undefined;
  /** Test seams. */
  readonly sleep?: ((ms: number, signal: AbortSignal) => Promise<void>) | undefined;
  readonly now?: (() => Date) | undefined;
}

/**
 * The system prompt the backend sends for a stage. T11 and T13 record it as a job input next to the
 * task prompt, with `promptJobInput()`.
 */
export function llmSystemPrompt(prompts: PromptRegistry, stage: PromptStage): PromptAsset {
  return prompts.latest(`${stage}.system`);
}

function isLlmProvider(value: string): value is LlmProvider {
  return (LLM_PROVIDERS as readonly string[]).includes(value);
}

function schemaFailure(errors: readonly ValidationIssue[]): LlmError {
  return new LlmError(
    'llm-schema-invalid',
    `model output failed contract validation (${String(errors.length)} problems)`,
    { retryable: true, detail: formatIssues(errors.slice(0, 20), 'output') },
  );
}

function parseClassification(output: unknown): ClassificationModelResult[] {
  const result = validateContract('classification-window-output', output);
  if (!result.ok) throw schemaFailure(result.errors);
  return result.value.results;
}

function parseRecap(output: unknown): Recap {
  const result = validateContract('recap', output);
  if (!result.ok) throw schemaFailure(result.errors);
  return result.value;
}

/** Builds the backend for a campaign. Unsupported providers are refused when a stage is called. */
export function createLlmBackend(options: LlmBackendOptions): LlmBackend {
  const { campaign, prompts } = options;
  const logger = options.logger ?? createLogger();
  const policy: RetryPolicy = { ...DEFAULT_RETRY, ...options.retry };
  const sleep = options.sleep ?? abortableSleep;
  const adapters = new Map<LlmProvider, LlmAdapter>();

  const adapterFor = (provider: LlmProvider): LlmAdapter => {
    let adapter = adapters.get(provider);
    if (adapter === undefined) {
      adapter =
        provider === 'claude-cli'
          ? createClaudeCodeAdapter(options.claudeCode)
          : createClaudeApiAdapter(options.claudeApi);
      adapters.set(provider, adapter);
    }
    return adapter;
  };

  async function run<T>(
    stage: PromptStage,
    call: LlmCall<T>,
    schema: Readonly<Record<string, unknown>>,
    parse: (output: unknown) => T,
  ): Promise<LlmResult<T>> {
    if (call.prompt.stage !== stage) {
      throw new LlmError(
        'llm-invalid-request',
        `prompt ${call.prompt.id} is not a ${stage} prompt`,
      );
    }
    const provider = campaign.provider[stage];
    if (!isLlmProvider(provider)) {
      throw new LlmError(
        'llm-provider-unsupported',
        `campaign.yaml names provider ${provider} for ${stage}; supported: ${LLM_PROVIDERS.join(', ')}`,
      );
    }
    const model = campaign.llm_model?.[stage];
    if (model === undefined) {
      throw new LlmError(
        'llm-model-not-configured',
        `campaign.yaml has no llm_model.${stage}; set the explicit model ID to use`,
      );
    }
    const system = llmSystemPrompt(prompts, stage);
    const signal = call.signal;
    let usage: JobUsage = { input_tokens: 0, output_tokens: 0 };

    for (let attempt = 1; ; attempt++) {
      assertConsent({
        campaign,
        speakerIds: call.speakerIds,
        provider,
        stage,
        ...(options.now === undefined ? {} : { now: options.now() }),
      });
      const started = Date.now();
      try {
        const response = await adapterFor(provider).call({
          model,
          system: system.body,
          user: renderPrompt(call.prompt, call.data).text,
          schema,
          timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          signal,
        });
        usage = addUsage(usage, response.usage);
        const output = parse(response.output);
        const problems = call.validate?.(output) ?? [];
        if (problems.length > 0) {
          throw new LlmError(
            'llm-schema-invalid',
            `model output failed validation (${String(problems.length)} problems)`,
            { retryable: true, detail: secretRedactor.redact(problems.slice(0, 20).join('\n')) },
          );
        }
        logger.info('llm.call', {
          stage,
          command: provider,
          status: 'ok',
          attempt,
          durationMs: Date.now() - started,
        });
        return {
          output,
          usage,
          provider,
          model,
          attempts: attempt,
          prompts: [call.prompt, system].map(({ id, version, hash }) => ({ id, version, hash })),
        };
      } catch (error) {
        if (!isLlmError(error)) throw error;
        // Adapter errors carry their call's usage; validation errors after a response carry none.
        usage = addUsage(usage, error.usage);
        logger.warn('llm.call', {
          stage,
          command: provider,
          status: 'error',
          attempt,
          errorCode: error.code,
          durationMs: Date.now() - started,
        });
        const exhausted = attempt >= policy.maxAttempts;
        if (!error.retryable || exhausted) {
          throw new LlmError(
            error.code,
            exhausted && error.retryable
              ? `${error.message} (gave up after ${String(attempt)} attempts)`
              : error.message,
            { usage, attempts: attempt, detail: error.detail },
          );
        }
        await sleep(backoffDelay(policy, attempt), signal ?? new AbortController().signal);
        if (signal?.aborted === true) {
          throw new LlmError('llm-cancelled', 'the LLM call was cancelled', {
            usage,
            attempts: attempt,
          });
        }
      }
    }
  }

  return {
    classify: (call) =>
      run('classification', call, modelSchema('classification-window-output'), parseClassification),
    writeRecap: (call) => run('recap', call, modelSchema('recap'), parseRecap),
  };
}
