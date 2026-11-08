/** The API adapter against an injected client. These tests never reach the network. */
import { describe, expect, it, vi } from 'vitest';
import {
  createAnthropicClient,
  type AnthropicClient,
  type AnthropicResponse,
} from '../../src/llm/claude-api.ts';
import {
  createLlmBackend,
  isLlmError,
  type ClaudeApiOptions,
  type LlmError,
  type SecretStore,
} from '../../src/llm/index.ts';
import { resolveApiKey } from '../../src/llm/secrets.ts';
import { createLogger, secretRedactor } from '../../src/log/index.ts';
import {
  classifyPrompt,
  llmCampaign,
  prompts,
  speakerIds,
  TRANSCRIPT,
  validClassification,
} from './helpers.ts';

const anthropicCtor = vi.hoisted(() => vi.fn());
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = {};
    constructor(options: unknown) {
      anthropicCtor(options);
    }
  },
}));

const KEY = 'sk-ant-api03-TESTKEYTESTKEYTESTKEY';
const config = llmCampaign('claude-api');
const call = {
  prompt: classifyPrompt(),
  data: { transcript: TRANSCRIPT },
  speakerIds: speakerIds(config),
};

const store = (value: string | undefined): (() => Promise<SecretStore>) =>
  vi.fn(() =>
    Promise.resolve({
      get: () => value,
      set: () => undefined,
      delete: () => false,
    }),
  );

const ok = (output: unknown = { results: [validClassification()] }): AnthropicResponse => ({
  stop_reason: 'end_turn',
  usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 2 },
  content: [{ type: 'text', text: JSON.stringify(output) }],
});

function backendWith(send: AnthropicClient['send'], options: ClaudeApiOptions = {}) {
  const createClient = vi.fn(() => ({ send }));
  const backend = createLlmBackend({
    campaign: config,
    prompts,
    retry: { baseDelayMs: 1, maxDelayMs: 1 },
    logger: createLogger({ sink: () => undefined }),
    claudeApi: { openStore: store(KEY), env: {}, createClient, ...options },
  });
  return { backend, createClient };
}

async function failure(promise: Promise<unknown>): Promise<LlmError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!isLlmError(error)) throw new Error('expected an LlmError', { cause: error });
  return error;
}

describe('Claude API adapter', () => {
  it('passes the stored key and explicit model, with the transcript as user content', async () => {
    const send = vi.fn<AnthropicClient['send']>(() => Promise.resolve(ok()));
    const { backend, createClient } = backendWith(send);
    const result = await backend.classify(call);
    expect(createClient).toHaveBeenCalledWith(KEY);
    const request = send.mock.calls[0]?.[0];
    expect(request?.model).toBe('model-for-classify');
    expect(request?.messages[0].content).toContain(TRANSCRIPT);
    expect(request?.system).not.toContain(TRANSCRIPT);
    expect(request?.output_config.format.type).toBe('json_schema');
    expect(result.provider).toBe('claude-api');
    expect(result.usage).toEqual({ input_tokens: 7, output_tokens: 7 });
  });

  it('retries schema-invalid output within bounds', async () => {
    const send = vi
      .fn<AnthropicClient['send']>()
      .mockResolvedValueOnce(ok({ results: [{ label: 'banana' }] }))
      .mockResolvedValue(ok());
    const result = await backendWith(send).backend.classify(call);
    expect(result.attempts).toBe(2);
    expect(result.usage.output_tokens).toBe(14);
  });

  it('does not retry a refusal or a truncated answer', async () => {
    for (const [stop_reason, code] of [
      ['refusal', 'llm-refusal'],
      ['max_tokens', 'llm-max-tokens'],
    ] as const) {
      const send = vi.fn<AnthropicClient['send']>(() => Promise.resolve({ ...ok(), stop_reason }));
      const error = await failure(backendWith(send).backend.classify(call));
      expect(error.code).toBe(code);
      expect(send).toHaveBeenCalledTimes(1);
    }
  });

  it('retries 429 and 5xx but not 400 or 401', async () => {
    for (const [status, code, calls] of [
      [429, 'llm-api-error', 3],
      [529, 'llm-api-error', 3],
      [400, 'llm-api-rejected', 1],
      [401, 'llm-api-auth', 1],
    ] as const) {
      const send = vi.fn<AnthropicClient['send']>(() =>
        Promise.reject(Object.assign(new Error('nope'), { status })),
      );
      const error = await failure(backendWith(send).backend.classify(call));
      expect(error.code).toBe(code);
      expect(send).toHaveBeenCalledTimes(calls);
    }
  });

  it('redacts the key from SDK errors and keeps no cause', async () => {
    const send = vi.fn<AnthropicClient['send']>(() =>
      Promise.reject(Object.assign(new Error(`bad header x-api-key: ${KEY}`), { status: 400 })),
    );
    const error = await failure(backendWith(send).backend.classify(call));
    expect(error.message).not.toContain(KEY);
    expect(error.detail).toContain('[REDACTED]');
    expect(error.detail).not.toContain(KEY);
    expect(error.cause).toBeUndefined();
  });

  it('times out and cancels through the signal', async () => {
    const hang: AnthropicClient['send'] = (_request, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(new Error('aborted'));
        });
      });
    const timedOut = createLlmBackend({
      campaign: config,
      prompts,
      timeoutMs: 20,
      retry: { maxAttempts: 1 },
      logger: createLogger({ sink: () => undefined }),
      claudeApi: { openStore: store(KEY), env: {}, createClient: () => ({ send: hang }) },
    });
    expect((await failure(timedOut.classify(call))).code).toBe('llm-timeout');

    const controller = new AbortController();
    const pending = backendWith(hang).backend.classify({ ...call, signal: controller.signal });
    setTimeout(() => {
      controller.abort();
    }, 10);
    expect((await failure(pending)).code).toBe('llm-cancelled');
  });

  it('refuses before reading the key when consent fails', async () => {
    const openStore = store(KEY);
    const send = vi.fn<AnthropicClient['send']>();
    await expect(
      backendWith(send, { openStore }).backend.classify({ ...call, speakerIds: ['nobody'] }),
    ).rejects.toThrow(/consent/);
    expect(openStore).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});

describe('API key resolution', () => {
  it('prefers the credential store and registers the key for redaction', async () => {
    const key = 'stored-key-value-for-redaction';
    expect(await resolveApiKey({ openStore: store(key), env: { CI: 'true' } })).toBe(key);
    expect(secretRedactor.redact(`x ${key} y`)).toBe('x [REDACTED] y');
  });

  it('ignores the env var outside CI', async () => {
    const error = await failure(
      resolveApiKey({ openStore: store(undefined), env: { ANTHROPIC_API_KEY: KEY } }),
    );
    expect(error.code).toBe('llm-no-api-key');
    expect(error.message).toContain('recap secrets set anthropic');
  });

  it('accepts the env var in CI or when explicitly allowed', async () => {
    const env = { ANTHROPIC_API_KEY: KEY };
    expect(await resolveApiKey({ openStore: store(undefined), env: { ...env, CI: 'true' } })).toBe(
      KEY,
    );
    expect(await resolveApiKey({ openStore: store(undefined), env, allowEnvKey: true })).toBe(KEY);
  });

  it('survives a machine without a credential backend', async () => {
    const openStore = (): Promise<SecretStore> => Promise.reject(new Error('no dbus'));
    expect((await failure(resolveApiKey({ openStore, env: {} }))).code).toBe('llm-no-api-key');
  });
});

describe('real SDK client options', () => {
  it('pins the identity and endpoint and turns SDK retries off', async () => {
    await createAnthropicClient(KEY);
    expect(anthropicCtor).toHaveBeenCalledWith({
      apiKey: KEY,
      authToken: null,
      baseURL: 'https://api.anthropic.com',
      maxRetries: 0,
    });
  });
});
