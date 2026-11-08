/**
 * API key storage and resolution (docs/spikes/S05-llm-backends.md section 9). The key lives in the
 * OS credential store (Windows Credential Manager): never in config files or the repository.
 */
import { secretRedactor } from '../log/index.ts';
import { LlmError } from './errors.ts';

export const KEYRING_SERVICE = 'sargas-recap';
export const KEYRING_ACCOUNT = 'anthropic-api-key';
export const API_KEY_ENV = 'ANTHROPIC_API_KEY';

export interface SecretStore {
  get(): string | undefined;
  set(value: string): void;
  /** True when a stored value was removed. */
  delete(): boolean;
}

/** The OS credential store. The native module is loaded only when a key is really needed. */
export async function openOsSecretStore(): Promise<SecretStore> {
  const { Entry } = await import('@napi-rs/keyring');
  const entry = new Entry(KEYRING_SERVICE, KEYRING_ACCOUNT);
  return {
    get: () => entry.getPassword() ?? undefined,
    set: (value) => {
      entry.setPassword(value);
    },
    delete: () => entry.deleteCredential(),
  };
}

export interface ResolveApiKeyOptions {
  readonly openStore?: (() => Promise<SecretStore>) | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  /** Accept `ANTHROPIC_API_KEY` outside CI. */
  readonly allowEnvKey?: boolean | undefined;
}

async function fromStore(open: () => Promise<SecretStore>): Promise<string | undefined> {
  try {
    const store = await open();
    return store.get();
  } catch {
    // No credential backend (typically headless Linux). The env fallback or the error below applies.
    return undefined;
  }
}

/**
 * Credential store first; `ANTHROPIC_API_KEY` only in CI or when explicitly allowed. The key is
 * registered with the process redactor before it is returned.
 */
export async function resolveApiKey(options: ResolveApiKeyOptions = {}): Promise<string> {
  const env = options.env ?? process.env;
  const stored = await fromStore(options.openStore ?? openOsSecretStore);
  const envAllowed = env['CI'] === 'true' || options.allowEnvKey === true;
  const key = stored ?? (envAllowed ? env[API_KEY_ENV] : undefined);
  if (key === undefined || key === '') {
    throw new LlmError(
      'llm-no-api-key',
      'no Anthropic API key in the OS credential store; run `recap secrets set anthropic`',
    );
  }
  secretRedactor.add(key);
  return key;
}
