import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toJsonSchema } from '@sargas-recap/contracts';
import { configVersion } from '../../src/config/index.ts';
import {
  defineStages,
  latestJob,
  runStage,
  StageError,
  type RunConfig,
} from '../../src/jobs/index.ts';
import {
  isLlmError,
  llmSystemPrompt,
  registerSecretsCommands,
  type LlmError,
  type SecretStore,
} from '../../src/llm/index.ts';
import { modelSchema } from '../../src/llm/output-schema.ts';
import { createLogger, SecretRedactor } from '../../src/log/index.ts';
import { promptJobInput } from '../../src/prompts/index.ts';
import { glossary } from '../config/helpers.ts';
import { openFixture, type Fixture } from '../jobs/helpers.ts';
import {
  classifyPrompt,
  fakeRun,
  llmCampaign,
  prompts,
  recapPrompt,
  speakerIds,
  TRANSCRIPT,
  validClassificationOutput,
  type FakeRun,
} from './helpers.ts';

const call = (config = llmCampaign()) => ({
  prompt: classifyPrompt(),
  data: { transcript: TRANSCRIPT },
  speakerIds: speakerIds(config),
});

async function failure(promise: Promise<unknown>): Promise<LlmError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!isLlmError(error)) throw new Error('expected an LlmError', { cause: error });
  return error;
}

let run: FakeRun | undefined;
let fixture: Fixture | undefined;
afterEach(() => {
  run?.cleanup();
  run = undefined;
  fixture?.cleanup();
  fixture = undefined;
});

describe('backend selection', () => {
  it('refuses a provider without an adapter, before spawning', async () => {
    const config = llmCampaign('some-other-llm');
    const spawn = vi.fn();
    run = fakeRun('valid', {}, config);
    const error = await failure(run.backend({ claudeCode: { spawn } }).classify(call(config)));
    expect(error.code).toBe('llm-provider-unsupported');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('has no default model', async () => {
    const config = llmCampaign();
    delete config.llm_model;
    run = fakeRun('valid', {}, config);
    expect((await failure(run.backend().classify(call(config)))).code).toBe(
      'llm-model-not-configured',
    );
  });

  it('refuses a prompt from the wrong stage', async () => {
    run = fakeRun('valid');
    const error = await failure(run.backend().classify({ ...call(), prompt: recapPrompt() }));
    expect(error.code).toBe('llm-invalid-request');
  });

  it('sends the registry system prompt', async () => {
    run = fakeRun('valid', validClassificationOutput());
    await run.backend().classify(call());
    const { args } = run.record();
    expect(args[args.indexOf('--system-prompt') + 1]).toBe(
      llmSystemPrompt(prompts, 'classification').body,
    );
  });
});

describe('provider schema', () => {
  const FORBIDDEN = ['pattern', 'minLength', 'maxLength', 'minimum', 'maximum', 'allOf', 'if'];

  function keywords(node: unknown, found: Set<string>): Set<string> {
    if (Array.isArray(node)) node.forEach((n) => keywords(n, found));
    else if (typeof node === 'object' && node !== null) {
      for (const [key, value] of Object.entries(node)) {
        if (key === 'properties') {
          Object.values(value as object).forEach((v) => keywords(v, found));
        } else {
          found.add(key);
          keywords(value, found);
        }
      }
    }
    return found;
  }

  it('drops what structured output rejects and keeps the shape', () => {
    for (const schema of [modelSchema('classification-window-output'), modelSchema('recap')]) {
      const found = keywords(schema, new Set());
      for (const keyword of FORBIDDEN) expect(found.has(keyword)).toBe(false);
      expect(schema['type']).toBe('object');
      expect(schema['additionalProperties']).toBe(false);
    }
  });

  it('keeps every required property of the contract', () => {
    expect(modelSchema('recap')['required']).toEqual(toJsonSchema('recap')['required']);
  });
});

describe('job records', () => {
  function setup(modes: string, output: unknown) {
    const config = llmCampaign();
    const runConfig: RunConfig = {
      campaign: config,
      glossary: glossary(),
      version: configVersion(config, glossary()),
    };
    const backendRun = fakeRun(modes, output, config);
    run = backendRun;
    const stages = defineStages([
      {
        name: 'classify',
        inputs: () => [promptJobInput(classifyPrompt())],
        provider: { purpose: 'classification', speakerIds: () => speakerIds(config) },
        run: async (ctx) => {
          const result = await backendRun
            .backend()
            .classify({ ...call(config), signal: ctx.signal });
          return { usage: result.usage };
        },
      },
    ]);
    return { config, runConfig, stages };
  }

  it('records the usage of every attempt on the job', async () => {
    fixture = await openFixture();
    const { config, runConfig, stages } = setup(
      'schema-invalid,valid',
      validClassificationOutput(),
    );
    const report = await runStage({
      db: fixture.db,
      campaignId: config.campaign_id,
      sessionId: 's1',
      stage: 'classify',
      stages,
      config: runConfig,
      logger: fixture.logger,
    });
    expect(report.status).toBe('succeeded');
    const job = latestJob(fixture.db, config.campaign_id, 's1', 'classify');
    expect(job?.usage).toEqual({ input_tokens: 160, output_tokens: 40 });
  });

  it('does not multiply the retry budget in the runner', async () => {
    fixture = await openFixture();
    const { config, runConfig, stages } = setup('schema-invalid', {});
    const report = await runStage({
      db: fixture.db,
      campaignId: config.campaign_id,
      sessionId: 's1',
      stage: 'classify',
      stages,
      config: runConfig,
      logger: fixture.logger,
      sleep: () => Promise.resolve(),
    });
    expect(report.status).toBe('failed');
    expect(run?.invocations()).toBe(3);
    const job = latestJob(fixture.db, config.campaign_id, 's1', 'classify');
    expect(job?.error?.code).toBe('llm-schema-invalid');
    expect(job?.error?.retryable).toBe(false);
    expect(job?.error?.message).not.toContain('banana');
  });

  it('is a StageError, so the runner records its code', async () => {
    run = fakeRun('non-json');
    const error = await failure(run.backend({ retry: { maxAttempts: 1 } }).classify(call()));
    expect(error).toBeInstanceOf(StageError);
  });
});

describe('redaction', () => {
  const KEY = 'sk-ant-api03-ABCDEFGHIJKLMNOP';

  it('masks registered values and their encodings', () => {
    const redactor = new SecretRedactor().add('my-private-value/+=');
    expect(redactor.redact('a my-private-value/+= b')).toBe('a [REDACTED] b');
    expect(redactor.redact(encodeURIComponent('my-private-value/+='))).toBe('[REDACTED]');
    expect(redactor.redact(Buffer.from('my-private-value/+=').toString('base64'))).toBe(
      '[REDACTED]',
    );
  });

  it('masks key and bearer patterns even when unregistered, keeping JSON valid', () => {
    const redactor = new SecretRedactor();
    expect(redactor.redact(`key ${KEY}`)).toBe('key [REDACTED]');
    expect(redactor.redact('Authorization: Bearer abcdefghijklmnop')).toBe(
      'Authorization: Bearer [REDACTED]',
    );
    const value = { headers: 'x-api-key: abcdefghijkl', note: `"${KEY}"` };
    expect(redactor.redactValue(value).note).toBe('"[REDACTED]"');
  });

  it('applies to allowed log fields', () => {
    const lines: string[] = [];
    createLogger({ sink: (line) => lines.push(line) }).info('e', { command: KEY });
    expect(lines.join()).not.toContain(KEY);
    expect((JSON.parse(lines[0] ?? '{}') as { command: string }).command).toBe('[REDACTED]');
  });
});

describe('recap secrets', () => {
  function cli(readSecret: () => Promise<string>) {
    const saved: string[] = [];
    const store: SecretStore = {
      get: () => saved[0],
      set: (value) => saved.push(value),
      delete: () => saved.splice(0).length > 0,
    };
    const output: string[] = [];
    const io = { out: (t: string) => output.push(t), err: (t: string) => output.push(t) };
    const program = new Command().exitOverride();
    registerSecretsCommands(program, io, {
      openStore: () => Promise.resolve(store),
      readSecret,
    });
    return { program, saved, output };
  }
  const exec = (program: Command, ...args: string[]) => program.parseAsync(args, { from: 'user' });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it('stores the key without echoing it', async () => {
    const { program, saved, output } = cli(() => Promise.resolve(' sk-ant-api03-SECRETVALUE \n'));
    await exec(program, 'secrets', 'set', 'anthropic');
    expect(saved).toEqual(['sk-ant-api03-SECRETVALUE']);
    expect(output.join('')).not.toContain('SECRETVALUE');
  });

  it('stores nothing for an empty key and refuses unknown names', async () => {
    const empty = cli(() => Promise.resolve('  '));
    await exec(empty.program, 'secrets', 'set', 'anthropic');
    expect(empty.saved).toEqual([]);
    expect(process.exitCode).toBe(1);

    const unknown = cli(() => Promise.resolve('x'));
    await exec(unknown.program, 'secrets', 'set', 'other');
    expect(process.exitCode).toBe(2);
  });

  it('deletes the key', async () => {
    const { program, saved, output } = cli(() => Promise.resolve('value-value'));
    await exec(program, 'secrets', 'set', 'anthropic');
    await exec(program, 'secrets', 'delete', 'anthropic');
    expect(saved).toEqual([]);
    expect(output.join('')).toContain('removed');
  });
});
