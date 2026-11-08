/**
 * LLM backend (T10). Adapters are not exported: `createLlmBackend` is the only way to reach a
 * provider, so `assertConsent()` cannot be skipped.
 */
export {
  createLlmBackend,
  LLM_PROVIDERS,
  llmSystemPrompt,
  type LlmBackend,
  type LlmBackendOptions,
  type LlmCall,
  type LlmProvider,
  type LlmResult,
} from './backend.ts';
export { addUsage } from './adapter.ts';
export { CLAUDE_BINARY_ENV, type ClaudeCodeOptions } from './claude-code.ts';
export type { ClaudeApiOptions } from './claude-api.ts';
export { isLlmError, LlmError, type LlmErrorCode } from './errors.ts';
export { openOsSecretStore, type SecretStore } from './secrets.ts';
export { registerSecretsCommands, type SecretsCliDeps } from './cli.ts';
