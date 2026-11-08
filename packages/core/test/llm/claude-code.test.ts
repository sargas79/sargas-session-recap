import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConsentError } from '../../src/config/index.ts';
import { buildChildEnv, buildClaudeArgs, TOOL_LOCKDOWN_ARGS } from '../../src/llm/claude-code.ts';
import { isLlmError, type LlmError } from '../../src/llm/index.ts';
import {
  classifyPrompt,
  fakeRun,
  llmCampaign,
  probes,
  recapPrompt,
  speakerIds,
  TRANSCRIPT,
  validClassification,
  validRecap,
  type FakeRun,
} from './helpers.ts';

const config = llmCampaign();
const call = {
  prompt: classifyPrompt(),
  data: { transcript: TRANSCRIPT },
  speakerIds: speakerIds(config),
};
const validOutput = (): unknown => ({ results: [validClassification()] });

let run: FakeRun | undefined;
function start(modes: string, output: unknown = validOutput()): FakeRun {
  run = fakeRun(modes, output);
  return run;
}
afterEach(() => {
  run?.cleanup();
  run = undefined;
});

async function failure(promise: Promise<unknown>): Promise<LlmError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!isLlmError(error)) throw new Error('expected an LlmError', { cause: error });
  return error;
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const LOCKDOWN = [
  '--tools',
  '',
  '--disallowedTools',
  'Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch,NotebookEdit,Task,TodoWrite',
  '--strict-mcp-config',
  '--mcp-config',
  '{"mcpServers":{}}',
];

function expectLockdown(args: readonly string[]): void {
  const at = args.indexOf('--tools');
  expect(at).toBeGreaterThanOrEqual(0);
  expect(args.slice(at, at + LOCKDOWN.length)).toEqual(LOCKDOWN);
}

describe('Claude Code argv', () => {
  it('always carries every tool-disable flag', () => {
    expectLockdown(buildClaudeArgs({ model: 'm', schema: '{}', system: 's' }));
    expect(Object.isFrozen(TOOL_LOCKDOWN_ARGS)).toBe(true);
  });

  it('sends the flags on the real spawn, with the transcript only on stdin', async () => {
    const r = start('valid');
    await r.backend().classify(call);
    const { args, stdin } = r.record();
    expectLockdown(args);
    expect(args).toContain('--no-session-persistence');
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('');
    expect(args[args.indexOf('--model') + 1]).toBe('model-for-classify');
    expect(args[args.indexOf('--output-format') + 1]).toBe('json');
    expect(args.join(' ')).not.toContain(TRANSCRIPT);
    expect(stdin).toContain(TRANSCRIPT);
  });

  it('has exactly one place in the source that lists --tools', () => {
    const dir = fileURLToPath(new URL('../../src/', import.meta.url));
    const hits = (readdirSync(dir, { recursive: true }) as string[])
      .map((file) => path.join(dir, file))
      .filter((file) => file.endsWith('.ts') && statSync(file).isFile())
      .filter((file) => readFileSync(file, 'utf8').includes("'--tools'"));
    expect(hits.map((file) => path.basename(file))).toEqual(['claude-code.ts']);
  });

  it('is reached only through the backend, where consent runs', () => {
    const dir = fileURLToPath(new URL('../../src/', import.meta.url));
    const importers = (readdirSync(dir, { recursive: true }) as string[])
      .filter((file) => file.endsWith('.ts'))
      .filter((file) =>
        /from '.*claude-(code|api)\.ts'/.test(
          readFileSync(path.join(dir, file), 'utf8').replace(/export .* from .*/g, ''),
        ),
      );
    expect(importers.map((file) => path.basename(file))).toEqual(['backend.ts']);
  });
});

describe('Claude Code child environment', () => {
  it('drops API-key variables and anything not allowlisted', () => {
    const env = buildChildEnv({
      Path: 'C:\\bin',
      USERPROFILE: 'C:\\Users\\x',
      ANTHROPIC_API_KEY: 'sk-ant-api03-FAKEFAKEFAKEFAKE',
      ANTHROPIC_AUTH_TOKEN: 'token-token-token',
      anthropic_api_key: 'lowercase-variant',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-oauth-oauth',
      MY_OTHER_SECRET: 'nope',
    });
    expect(Object.keys(env).sort()).toEqual(['Path', 'USERPROFILE']);
  });

  it('removes credentials even from the extra variables', () => {
    expect(buildChildEnv({}, { ANTHROPIC_API_KEY: 'x', FAKE: 'y' })).toEqual({ FAKE: 'y' });
  });

  it('does not let an inherited key reach the process', async () => {
    const r = start('valid');
    const backend = r.backend({
      claudeCode: {
        command: process.execPath,
        prefixArgs: [path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-claude.mjs')],
        env: { ...process.env, ANTHROPIC_API_KEY: 'sk-ant-api03-INHERITEDINHERITED' },
      },
    });
    await backend.classify(call);
    expect(r.record().envNames.map((n) => n.toUpperCase())).not.toContain('ANTHROPIC_API_KEY');
  });
});

describe('Claude Code isolation', () => {
  it('runs in a fresh temp directory and removes it', async () => {
    const r = start('valid');
    await r.backend().classify(call);
    const { cwd } = r.record();
    expect(path.resolve(cwd)).not.toBe(path.resolve(process.cwd()));
    expect(existsSync(cwd)).toBe(false);
  });

  it('discards a result when something wrote to the working directory', async () => {
    const error = await failure(start('write-cwd').backend().classify(call));
    expect(error.code).toBe('llm-tools-not-disabled');
  });
});

describe('Claude Code results', () => {
  it('returns validated output and token usage including cached input', async () => {
    const result = await start('valid').backend().classify(call);
    expect(result.output).toEqual([validClassification()]);
    expect(result.usage).toEqual({ input_tokens: 80, output_tokens: 20 });
    expect(result.provider).toBe('claude-cli');
    expect(result.model).toBe('model-for-classify');
    expect(result.attempts).toBe(1);
    expect(result.prompts.map((p) => p.id)).toEqual([
      'classification.window',
      'classification.system',
    ]);
  });

  it('writes a recap with the recap model', async () => {
    const r = start('valid', validRecap());
    const result = await r.backend().writeRecap({ ...call, prompt: recapPrompt() });
    expect(result.output.title).toBe(validRecap().title);
    const { args } = r.record();
    expect(args[args.indexOf('--model') + 1]).toBe('model-for-recap');
  });

  it('treats is_error with subtype success as a failure', async () => {
    const r = start('is-error');
    const error = await failure(r.backend().classify(call));
    expect(error.code).toBe('llm-cli-error');
    expect(r.invocations()).toBe(3);
  });

  it('maps not logged in to a clear non-retryable error', async () => {
    const r = start('not-logged-in');
    const error = await failure(r.backend().classify(call));
    expect(error.code).toBe('llm-not-logged-in');
    expect(error.message).toContain('/login');
    expect(error.retryable).toBe(false);
    expect(r.invocations()).toBe(1);
  });

  it('maps an unrecognized model to a non-retryable error', async () => {
    const r = start('invalid-model');
    const error = await failure(r.backend().classify(call));
    expect(error.code).toBe('llm-invalid-model');
    expect(r.invocations()).toBe(1);
  });

  it('rejects non-JSON output, retrying within bounds', async () => {
    const r = start('non-json');
    const error = await failure(r.backend().classify(call));
    expect(error.code).toBe('llm-non-json');
    expect(r.invocations()).toBe(3);
    expect(error.attempts).toBe(3);
    expect(error.retryable).toBe(false);
  });

  it('rejects schema-invalid output, retries and sums usage', async () => {
    const r = start('schema-invalid,valid');
    const result = await r.backend().classify(call);
    expect(result.attempts).toBe(2);
    expect(r.invocations()).toBe(2);
    expect(result.usage).toEqual({ input_tokens: 160, output_tokens: 40 });
  });

  it('gives up on schema-invalid output after the budget, with the usage spent', async () => {
    const r = start('schema-invalid');
    const error = await failure(
      r.backend({ retry: { maxAttempts: 2, baseDelayMs: 1 } }).classify(call),
    );
    expect(error.code).toBe('llm-schema-invalid');
    expect(r.invocations()).toBe(2);
    expect(error.usage).toEqual({ input_tokens: 160, output_tokens: 40 });
    expect(error.message).not.toContain('banana');
  });

  it('requires structured_output and does not parse the prose result', async () => {
    expect((await failure(start('no-structured-output').backend().classify(call))).code).toBe(
      'llm-schema-invalid',
    );
  });

  it('counts failed caller validation against the budget', async () => {
    const r = start('valid');
    const error = await failure(
      r.backend().classify({ ...call, validate: () => ['unknown segment id at index 0'] }),
    );
    expect(error.code).toBe('llm-schema-invalid');
    expect(r.invocations()).toBe(3);
  });

  it('stops on oversize output', async () => {
    const r = start('huge');
    const error = await failure(r.backend({ claudeCode: { maxStdoutBytes: 1024 } }).classify(call));
    expect(error.code).toBe('llm-output-too-large');
    expect(r.invocations()).toBe(1);
  });

  it('reports a missing binary without retrying', async () => {
    const spawn = vi.fn(() => {
      throw Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
    });
    const error = await failure(
      start('valid')
        .backend({ claudeCode: { spawn, prefixArgs: [] } })
        .classify(call),
    );
    expect(error.code).toBe('llm-binary-not-found');
    expect(error.message).toContain('RECAP_CLAUDE');
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('reports a real ENOENT from a binary that does not exist', async () => {
    const error = await failure(
      start('valid')
        .backend({ claudeCode: { command: 'no-such-claude-binary-xyz', prefixArgs: [] } })
        .classify(call),
    );
    expect(error.code).toBe('llm-binary-not-found');
  });

  it.runIf(process.platform === 'win32')('refuses a .cmd shim', async () => {
    const error = await failure(
      start('valid')
        .backend({ claudeCode: { command: 'C:\\npm\\claude.cmd' } })
        .classify(call),
    );
    expect(error.code).toBe('llm-binary-not-found');
    expect(error.message).toContain('.cmd');
  });
});

describe('Claude Code timeout and cancellation', () => {
  async function expectTreeDead(r: FakeRun): Promise<void> {
    const pid = Number(readFileSync(r.pidFile, 'utf8'));
    await waitFor(() => !isAlive(pid), 'the grandchild to die');
  }

  it('kills the whole tree on timeout', { timeout: 40_000 }, async () => {
    const r = start('hang-tree');
    const error = await failure(
      r.backend({ timeoutMs: 5_000, retry: { maxAttempts: 1 } }).classify(call),
    );
    expect(error.code).toBe('llm-timeout');
    await expectTreeDead(r);
  });

  it('retries a timeout within bounds', { timeout: 40_000 }, async () => {
    const r = start('hang-tree,valid');
    const result = await r.backend({ timeoutMs: 5_000 }).classify(call);
    expect(result.attempts).toBe(2);
  });

  it('kills the whole tree on cancellation and does not retry', { timeout: 40_000 }, async () => {
    const r = start('hang-tree');
    const controller = new AbortController();
    const pending = r
      .backend({ timeoutMs: 30_000 })
      .classify({ ...call, signal: controller.signal });
    await waitFor(() => existsSync(r.pidFile), 'the fake CLI to start');
    controller.abort();
    const error = await failure(pending);
    expect(error.code).toBe('llm-cancelled');
    expect(r.invocations()).toBe(1);
    await expectTreeDead(r);
  });

  it('calls the tree killer with the child pid', { timeout: 40_000 }, async () => {
    const r = start('hang-tree');
    const killTree = vi.fn((pid: number) => {
      process.kill(pid);
      return Promise.resolve();
    });
    const controller = new AbortController();
    const pending = r
      .backend({ timeoutMs: 30_000, claudeCode: { killTree, killGraceMs: 500 } })
      .classify({ ...call, signal: controller.signal });
    await waitFor(() => existsSync(r.pidFile), 'the fake CLI to start');
    controller.abort();
    await failure(pending);
    expect(killTree).toHaveBeenCalledTimes(1);
    const grandchild = Number(readFileSync(r.pidFile, 'utf8'));
    if (isAlive(grandchild)) process.kill(grandchild);
  });

  it('never spawns when already cancelled', async () => {
    const spawn = vi.fn();
    const controller = new AbortController();
    controller.abort();
    const error = await failure(
      start('valid')
        .backend({ claudeCode: { spawn } })
        .classify({ ...call, signal: controller.signal }),
    );
    expect(error.code).toBe('llm-cancelled');
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('secrets and consent', () => {
  it('keeps a key out of the error and redacts it in the diagnostics', async () => {
    const r = start('exit-with-secret');
    const error = await failure(r.backend({ retry: { maxAttempts: 1 } }).classify(call));
    expect(error.code).toBe('llm-exit-nonzero');
    expect(`${error.message}\n${error.stack ?? ''}`).not.toContain('sk-ant-');
    expect(error.detail).toContain('[REDACTED]');
    expect(error.detail).not.toContain('FAKEFAKE');
    expect(error.cause).toBeUndefined();
    expect(r.logLines.join('\n')).not.toContain('sk-ant-');
  });

  it('logs no transcript or prompt', async () => {
    const r = start('valid');
    await r.backend().classify(call);
    expect(r.logLines.length).toBeGreaterThan(0);
    expect(r.logLines.join('\n')).not.toContain(TRANSCRIPT);
    expect(r.logLines.join('\n')).not.toContain('untrusted-data');
  });

  it('refuses before spawning when a speaker fails the consent check', async () => {
    const spawn = vi.fn();
    const promise = start('valid')
      .backend({ claudeCode: { spawn } })
      .classify({ ...call, speakerIds: ['not-in-campaign'] });
    await expect(promise).rejects.toBeInstanceOf(ConsentError);
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('prompt injection', () => {
  it('keeps every probe inside the single data block', async () => {
    const r = start('valid');
    await r.backend().classify({ ...call, data: { transcript: probes().join('\n') } });
    const { stdin, args } = r.record();
    const tag = /<(untrusted-data-[0-9a-f]{32}) name="transcript">/.exec(stdin)?.[1];
    expect(tag).toBeDefined();
    const closings = stdin.match(/<\/untrusted-data[^>]*>/g) ?? [];
    // The real closing tag, plus the prompt's sentence that names it. No probe added another.
    expect(closings.filter((c) => c === `</${String(tag)}>`)).toHaveLength(2);
    expect(closings).toHaveLength(2);
    expect(stdin).not.toContain('</untrusted-data-00000000000000000000000000000000>');
    expect(stdin).not.toContain('<untrusted-data-00000000000000000000000000000000');
    for (const probe of probes()) expect(args.join(' ')).not.toContain(probe);
  });

  it('rejects output shaped by an injection instead of trusting it', async () => {
    const error = await failure(
      start('valid', { results: [{ segment_id: 'forged', label: 'ic' }] })
        .backend()
        .classify(call),
    );
    expect(error.code).toBe('llm-schema-invalid');
  });
});
