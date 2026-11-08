/**
 * Claude Code CLI adapter (`claude -p`), following the live findings in
 * docs/spikes/S05-llm-backends.md sections 5 to 7 (CLI 2.1.317, Windows, subscription login).
 *
 * - Tools: every run carries all of {@link TOOL_LOCKDOWN_ARGS}. `--tools ""` alone leaves the user's
 *   MCP servers loaded next to untrusted transcript text, so the flags are one constant that no
 *   option can change.
 * - Failure: decided from `is_error` and the exit code. `subtype` says "success" on failed runs.
 * - Output: the envelope's `structured_output`. The CLI's schema enforcement is unproven, so the
 *   backend validates it with Ajv.
 * - Isolation: `spawn` with an argument array and no shell, transcript on stdin, a fresh empty temp
 *   cwd, an allowlisted env without API-key variables (an inherited key cannot silently bill the
 *   API), and whole-tree kill on timeout and cancellation.
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { secretRedactor } from '../log/index.ts';
import {
  usageFrom,
  type AdapterRequest,
  type AdapterResponse,
  type LlmAdapter,
} from './adapter.ts';
import { LlmError } from './errors.ts';
import { defaultSpawn, killProcessTree, type KillTreeFn, type SpawnFn } from './process.ts';

export const DISALLOWED_TOOLS =
  'Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch,NotebookEdit,Task,TodoWrite';

export const TOOL_LOCKDOWN_ARGS: readonly string[] = Object.freeze([
  '--tools',
  '',
  '--disallowedTools',
  DISALLOWED_TOOLS,
  '--strict-mcp-config',
  '--mcp-config',
  '{"mcpServers":{}}',
]);

/** Env vars the CLI needs to start and find its own login. Matched case-insensitively. */
const ENV_ALLOWLIST = new Set([
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'COMSPEC',
  'WINDIR',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'HOME',
  'APPDATA',
  'LOCALAPPDATA',
  'TEMP',
  'TMP',
  'LANG',
  'NO_COLOR',
  'CLAUDE_CONFIG_DIR',
]);

const CREDENTIAL_ENV = /^(ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN$)/i;

/** Env var naming the CLI executable; otherwise `claude` is looked up on PATH. */
export const CLAUDE_BINARY_ENV = 'RECAP_CLAUDE';

const INVALID_MODEL_MARKER = '[claude-code:unrecognized_model]';
const DEFAULT_MAX_STDOUT_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 1024 * 1024;
const DEFAULT_KILL_GRACE_MS = 5_000;
const DETAIL_CHARS = 1_000;

type Env = Readonly<Record<string, string | undefined>>;

/** The complete argument list. The tool lockdown is not a parameter. */
export function buildClaudeArgs(request: {
  readonly model: string;
  readonly schema: string;
  readonly system: string;
}): string[] {
  return [
    '-p',
    '--output-format',
    'json',
    '--no-session-persistence',
    // No user or project settings: without this the user's own context is loaded (measured in T10).
    '--setting-sources',
    '',
    '--model',
    request.model,
    '--json-schema',
    request.schema,
    '--system-prompt',
    request.system,
    ...TOOL_LOCKDOWN_ARGS,
  ];
}

/** The child env: allowlisted names only, and never a credential, even from `extra`. */
export function buildChildEnv(parent: Env, extra: Env = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value !== undefined && ENV_ALLOWLIST.has(name.toUpperCase())) env[name] = value;
  }
  for (const [name, value] of Object.entries(extra)) {
    if (value !== undefined) env[name] = value;
  }
  for (const name of Object.keys(env)) {
    if (CREDENTIAL_ENV.test(name)) Reflect.deleteProperty(env, name);
  }
  return env;
}

export interface ClaudeCodeOptions {
  /** Executable. Defaults to `RECAP_CLAUDE`, then `claude` on PATH. Not a `.cmd` shim. */
  readonly command?: string | undefined;
  /** Arguments before the CLI's own, e.g. the script path when `command` is `node`. */
  readonly prefixArgs?: readonly string[] | undefined;
  /** Environment to filter. Defaults to `process.env`. */
  readonly env?: Env | undefined;
  /** Test seam: variables added after the allowlist. Credentials are still removed. */
  readonly extraEnv?: Env | undefined;
  readonly maxStdoutBytes?: number | undefined;
  readonly maxStderrBytes?: number | undefined;
  readonly killGraceMs?: number | undefined;
  /** Test seams. */
  readonly spawn?: SpawnFn | undefined;
  readonly killTree?: KillTreeFn | undefined;
}

type ProcessEnd = 'exited' | 'timeout' | 'cancelled' | 'output-too-large';

interface ProcessResult {
  readonly end: ProcessEnd;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface ProcessInput {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly stdin: string;
  readonly timeoutMs: number;
  readonly signal: AbortSignal | undefined;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  readonly killGraceMs: number;
  readonly spawn: SpawnFn;
  readonly killTree: KillTreeFn;
}

function binaryNotFound(reason: string): LlmError {
  return new LlmError(
    'llm-binary-not-found',
    `the Claude Code CLI could not be started (${reason}); install it (winget install --id Anthropic.ClaudeCode -e) or set ${CLAUDE_BINARY_ENV} to the full path of claude.exe`,
  );
}

function runProcess(input: ProcessInput): Promise<ProcessResult> {
  return new Promise<ProcessResult>((resolve, reject) => {
    let child: ReturnType<SpawnFn>;
    try {
      child = input.spawn(input.command, input.args, {
        cwd: input.cwd,
        env: input.env,
        shell: false,
        windowsHide: true,
        // POSIX: own process group, so the whole tree can be killed.
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(spawnFailure(error));
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let ending: ProcessEnd | undefined;
    let settled = false;
    let graceTimer: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(graceTimer);
      input.signal?.removeEventListener('abort', onAbort);
    };
    const result = (end: ProcessEnd, exitCode: number | null): ProcessResult => ({
      end,
      exitCode,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    });
    const terminate = (end: ProcessEnd): void => {
      if (ending !== undefined || settled) return;
      ending = end;
      if (child.pid !== undefined) void input.killTree(child.pid);
      else child.kill('SIGKILL');
      // A surviving descendant can hold the pipes open; do not wait for `close` forever.
      graceTimer = setTimeout(() => {
        if (settled) return;
        cleanup();
        resolve(result(end, null));
      }, input.killGraceMs);
    };
    const onAbort = (): void => {
      terminate('cancelled');
    };

    const timeoutTimer = setTimeout(() => {
      terminate('timeout');
    }, input.timeoutMs);
    input.signal?.addEventListener('abort', onAbort, { once: true });
    if (input.signal?.aborted === true) terminate('cancelled');

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > input.maxStdoutBytes) terminate('output-too-large');
      else stdout.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > input.maxStderrBytes) terminate('output-too-large');
      else stderr.push(chunk);
    });
    child.once('error', (error) => {
      if (settled) return;
      cleanup();
      reject(spawnFailure(error));
    });
    child.once('close', (code) => {
      if (settled) return;
      cleanup();
      resolve(result(ending ?? 'exited', code));
    });
    // EPIPE when the child exits early is not an error of its own: the exit code decides.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(input.stdin, 'utf8');
  });
}

/** Keeps only the errno. Node's spawn error carries the whole argument list in `spawnargs`. */
function spawnFailure(error: unknown): LlmError {
  const code = (error as NodeJS.ErrnoException).code ?? 'unknown error';
  if (code === 'ENOENT' || code === 'EACCES' || code === 'EINVAL') return binaryNotFound(code);
  return new LlmError('llm-spawn-failed', `the Claude Code CLI failed to start (${code})`, {
    retryable: true,
  });
}

function stderrDetail(stderr: string): string | undefined {
  if (stderr === '') return undefined;
  // Redact everything before cutting, so a cut cannot split a secret past recognition.
  return secretRedactor.redact(stderr).slice(-DETAIL_CHARS);
}

function parseEnvelope(stdout: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;
}

function isTransientStatus(status: unknown): boolean {
  return typeof status === 'number' && (status === 429 || status >= 500);
}

/** Turns a finished process into a response or a typed error. Exported for direct testing. */
export function interpretRun(
  run: Pick<ProcessResult, 'exitCode' | 'stdout' | 'stderr'>,
): AdapterResponse {
  const detail = stderrDetail(run.stderr);
  const parsed = parseEnvelope(run.stdout);
  if (run.stderr.includes(INVALID_MODEL_MARKER)) {
    throw new LlmError(
      'llm-invalid-model',
      'Claude Code does not recognize the model in campaign.yaml llm_model',
      { detail },
    );
  }
  if (parsed === undefined) {
    if (run.exitCode !== 0) {
      throw new LlmError(
        'llm-exit-nonzero',
        `the Claude Code CLI exited with code ${String(run.exitCode)} and no result`,
        { retryable: true, detail },
      );
    }
    throw new LlmError('llm-non-json', 'the Claude Code CLI did not print a JSON result', {
      retryable: true,
      detail,
    });
  }

  const usage = usageFrom(parsed['usage']);
  // Anything but an explicit `false` is treated as a failure.
  if (parsed['is_error'] !== false || run.exitCode !== 0) {
    if (usage.input_tokens === 0 && usage.output_tokens === 0 && run.stderr.trim() === '') {
      throw new LlmError(
        'llm-not-logged-in',
        'Claude Code failed before using any tokens, which usually means it is not logged in; run `claude`, then /login',
        { usage },
      );
    }
    throw new LlmError(
      'llm-cli-error',
      `Claude Code reported an error (exit code ${String(run.exitCode)})`,
      {
        retryable:
          parsed['api_error_status'] == null || isTransientStatus(parsed['api_error_status']),
        usage,
        detail,
      },
    );
  }

  const output = parsed['structured_output'];
  if (output === undefined || output === null) {
    throw new LlmError('llm-schema-invalid', 'the Claude Code result has no structured output', {
      retryable: true,
      usage,
    });
  }
  return { output: secretRedactor.redactValue(output), usage };
}

export function createClaudeCodeAdapter(options: ClaudeCodeOptions = {}): LlmAdapter {
  const parentEnv = options.env ?? process.env;
  const command = options.command ?? parentEnv[CLAUDE_BINARY_ENV] ?? 'claude';
  return {
    async call(request: AdapterRequest): Promise<AdapterResponse> {
      if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
        throw binaryNotFound('.cmd and .bat shims cannot run without a shell');
      }
      const cancelled = (): LlmError =>
        new LlmError('llm-cancelled', 'the Claude Code call was cancelled');
      if (request.signal?.aborted === true) throw cancelled();

      const cwd = await mkdtemp(path.join(tmpdir(), 'recap-llm-'));
      try {
        const run = await runProcess({
          command,
          args: [
            ...(options.prefixArgs ?? []),
            ...buildClaudeArgs({
              model: request.model,
              schema: JSON.stringify(request.schema),
              system: request.system,
            }),
          ],
          cwd,
          env: buildChildEnv(parentEnv, options.extraEnv),
          stdin: request.user,
          timeoutMs: request.timeoutMs,
          signal: request.signal,
          maxStdoutBytes: options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES,
          maxStderrBytes: options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES,
          killGraceMs: options.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
          spawn: options.spawn ?? defaultSpawn,
          killTree: options.killTree ?? killProcessTree,
        });
        if (run.end === 'cancelled') throw cancelled();
        if (run.end === 'timeout') {
          throw new LlmError(
            'llm-timeout',
            `the Claude Code CLI did not finish within ${String(request.timeoutMs)} ms`,
            { retryable: true },
          );
        }
        if (run.end === 'output-too-large') {
          throw new LlmError('llm-output-too-large', 'the Claude Code CLI printed too much output');
        }
        const entries = await readdir(cwd).catch(() => []);
        if (entries.length > 0) {
          throw new LlmError(
            'llm-tools-not-disabled',
            'the Claude Code run wrote to its working directory although tools are disabled; the result was discarded',
          );
        }
        return interpretRun(run);
      } finally {
        await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
          () => undefined,
        );
      }
    },
  };
}
