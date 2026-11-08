/**
 * Claude API adapter (fallback backend, `claude-api`). The S05 live run did not cover it: no key
 * exists yet, so it is exercised only against an injected client and never touches the network in
 * tests.
 *
 * The key comes from `resolveApiKey` and is passed explicitly. The real client also pins
 * `authToken: null` and `baseURL`: otherwise the SDK would add `ANTHROPIC_AUTH_TOKEN` or send the key
 * to `ANTHROPIC_BASE_URL`. SDK retries are off, so the backend's bounded retry is the only one.
 * Refusal fallbacks to other models are not enabled: the job must record the model that answered.
 */
import { secretRedactor } from '../log/index.ts';
import {
  usageFrom,
  type AdapterRequest,
  type AdapterResponse,
  type LlmAdapter,
} from './adapter.ts';
import { LlmError } from './errors.ts';
import { resolveApiKey, type ResolveApiKeyOptions } from './secrets.ts';

const API_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_MAX_TOKENS = 64_000;

export interface AnthropicRequest {
  readonly model: string;
  readonly max_tokens: number;
  readonly system: string;
  readonly messages: readonly [{ readonly role: 'user'; readonly content: string }];
  readonly output_config: {
    readonly format: {
      readonly type: 'json_schema';
      readonly schema: Readonly<Record<string, unknown>>;
    };
  };
}

/** The part of an SDK `Message` this adapter reads. */
export interface AnthropicResponse {
  readonly stop_reason: string | null;
  readonly usage: unknown;
  readonly content: readonly { readonly type: string; readonly text?: string }[];
}

export interface AnthropicClient {
  send(request: AnthropicRequest, signal: AbortSignal): Promise<AnthropicResponse>;
}

export type AnthropicClientFactory = (apiKey: string) => Promise<AnthropicClient> | AnthropicClient;

/** The real SDK client. Streams, so a long recap cannot hit an HTTP timeout. */
export const createAnthropicClient: AnthropicClientFactory = async (apiKey) => {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({
    apiKey,
    authToken: null,
    baseURL: API_BASE_URL,
    maxRetries: 0,
  });
  return {
    send: (request, signal) =>
      client.messages
        .stream(
          { ...request, messages: [...request.messages], output_config: request.output_config },
          { signal },
        )
        .finalMessage(),
  };
};

export interface ClaudeApiOptions extends ResolveApiKeyOptions {
  readonly maxTokens?: number | undefined;
  /** Test seam: replaces the SDK client. */
  readonly createClient?: AnthropicClientFactory | undefined;
}

function textOf(response: AnthropicResponse): string {
  return response.content
    .map((block) => (block.type === 'text' ? (block.text ?? '') : ''))
    .join('');
}

/** Maps a thrown SDK error by HTTP status. Only the status is kept: SDK errors carry headers. */
function apiFailure(error: unknown): LlmError {
  const status = (error as { status?: unknown } | null)?.status;
  const name = error instanceof Error ? error.name : typeof error;
  const message = error instanceof Error ? error.message : String(error);
  const detail = secretRedactor.redact(`${name}: ${message}`);
  if (status === 401 || status === 403) {
    return new LlmError('llm-api-auth', `the Claude API rejected the key (HTTP ${status})`, {
      detail,
    });
  }
  if (
    typeof status === 'number' &&
    status >= 400 &&
    status < 500 &&
    ![408, 409, 429].includes(status)
  ) {
    return new LlmError(
      'llm-api-rejected',
      `the Claude API rejected the request (HTTP ${status})`,
      {
        detail,
      },
    );
  }
  const what = typeof status === 'number' ? `HTTP ${String(status)}` : 'connection error';
  return new LlmError('llm-api-error', `the Claude API call failed (${what})`, {
    retryable: true,
    detail,
  });
}

function interpret(response: AnthropicResponse): AdapterResponse {
  const usage = usageFrom(response.usage);
  if (response.stop_reason === 'refusal') {
    throw new LlmError('llm-refusal', 'the model refused the request', { usage });
  }
  if (response.stop_reason === 'max_tokens') {
    throw new LlmError('llm-max-tokens', 'the model stopped at the output token limit', { usage });
  }
  let output: unknown;
  try {
    output = JSON.parse(textOf(response));
  } catch {
    throw new LlmError('llm-non-json', 'the Claude API response is not JSON', {
      retryable: true,
      usage,
    });
  }
  return { output: secretRedactor.redactValue(output), usage };
}

export function createClaudeApiAdapter(options: ClaudeApiOptions = {}): LlmAdapter {
  return {
    async call(request: AdapterRequest): Promise<AdapterResponse> {
      const apiKey = await resolveApiKey(options);
      const client = await (options.createClient ?? createAnthropicClient)(apiKey);
      const timeout = AbortSignal.timeout(request.timeoutMs);
      const signal =
        request.signal === undefined ? timeout : AbortSignal.any([request.signal, timeout]);
      let response: AnthropicResponse;
      try {
        response = await client.send(
          {
            model: request.model,
            max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
            system: request.system,
            messages: [{ role: 'user', content: request.user }],
            output_config: { format: { type: 'json_schema', schema: request.schema } },
          },
          signal,
        );
      } catch (error) {
        if (request.signal?.aborted === true) {
          throw new LlmError('llm-cancelled', 'the Claude API call was cancelled');
        }
        if (timeout.aborted) {
          throw new LlmError(
            'llm-timeout',
            `the Claude API did not answer within ${String(request.timeoutMs)} ms`,
            { retryable: true },
          );
        }
        throw apiFailure(error);
      }
      return interpret(response);
    },
  };
}
