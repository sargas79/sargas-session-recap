import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ToolsLock } from '@sargas-recap/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { modelInput, runStage } from '../../src/jobs/index.ts';
import {
  checkWhisper,
  inspectWhisper,
  loadWhisperOverrides,
  resolveWhisperTools,
  vulkanStatusFromOutput,
  whisperJobInputs,
  type VulkanStatus,
} from '../../src/tools/index.ts';
import { campaign, glossary } from '../config/helpers.ts';
import { newWorld, noSleep, openFixture, pipelineStages, runConfig } from '../jobs/helpers.ts';
import {
  DLL,
  EXE,
  localBuildLock,
  MODEL_A,
  MODEL_B,
  sha,
  workspace,
  type Workspace,
} from './helpers.ts';

let ws: Workspace;
const server = { url: (p: string): string => `https://example.invalid${p}` };
let lock: ToolsLock;

beforeEach(() => {
  ws = workspace();
  lock = localBuildLock(server);
});

afterEach(() => {
  ws.cleanup();
});

function installBinary(exe: Buffer = EXE, dll: Buffer = DLL): void {
  const dir = ws.paths.whisperBuildDir('v1.9.5-vulkan');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'whisper-cli'), exe);
  writeFileSync(path.join(dir, 'whisper.dll'), dll);
}

function installModel(file: string, body: Buffer): void {
  mkdirSync(ws.paths.whisperModelsDir, { recursive: true });
  writeFileSync(ws.paths.whisperModelFile(file), body);
}

function withActive(id: string): ToolsLock {
  return { ...lock, whisper: { ...lock.whisper, active_model: id } };
}

const found: VulkanStatus = {
  state: 'found',
  devices: [{ name: 'Fake GPU', type: 'discrete GPU' }],
};
const vulkan = (): Promise<VulkanStatus> => Promise.resolve(found);

describe('resolveWhisperTools', () => {
  it('returns verified paths and hashes', async () => {
    installBinary();
    installModel('ggml-a.bin', MODEL_A);
    const tools = await resolveWhisperTools({ paths: ws.paths, lock, overrides: {} });
    expect(tools.modelId).toBe('model-a');
    expect(tools.modelHash).toBe(sha(MODEL_A));
    expect(tools.warnings).toEqual([]);
  });

  it('refuses a missing model as not provisioned', async () => {
    installBinary();
    await expect(
      resolveWhisperTools({ paths: ws.paths, lock, overrides: {} }),
    ).rejects.toMatchObject({
      code: 'TOOLS_NOT_PROVISIONED',
    });
  });

  it('refuses a model or DLL that fails its hash as tampered', async () => {
    installBinary();
    installModel('ggml-a.bin', Buffer.from('tampered'));
    await expect(
      resolveWhisperTools({ paths: ws.paths, lock, overrides: {} }),
    ).rejects.toMatchObject({
      code: 'TOOLS_TAMPERED',
    });
    installModel('ggml-a.bin', MODEL_A);
    installBinary(EXE, Buffer.from('swapped dll'));
    await expect(
      resolveWhisperTools({ paths: ws.paths, lock, overrides: {} }),
    ).rejects.toMatchObject({
      code: 'TOOLS_TAMPERED',
    });
  });

  it('refuses an unsupported platform when there is no override', async () => {
    const report = await inspectWhisper(lock, ws.paths, {}, { platform: 'aix', arch: 'ppc' });
    expect(report.binary.state).toBe('unsupported-platform');
  });
});

describe('overrides', () => {
  function overrideFiles(exe: Buffer, model: Buffer): { binaryPath: string; modelPath: string } {
    const dir = path.join(ws.dir, 'own');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'whisper-cli'), exe);
    writeFileSync(path.join(dir, 'whisper.dll'), DLL);
    writeFileSync(path.join(dir, 'own.bin'), model);
    return { binaryPath: path.join(dir, 'whisper-cli'), modelPath: path.join(dir, 'own.bin') };
  }

  it('warns on a mismatch but stays usable, with the hash of the real files', async () => {
    const overrides = overrideFiles(Buffer.from('own build'), MODEL_B);
    const tools = await resolveWhisperTools({ paths: ws.paths, lock, overrides });
    expect(tools.binaryPath).toBe(overrides.binaryPath);
    expect(tools.modelHash).toBe(sha(MODEL_B));
    expect(tools.modelId).toBe('override');
    expect(tools.warnings).toEqual([
      expect.stringContaining('binary override does not match'),
      expect.stringContaining('model override does not match'),
    ]);
  });

  it('gives no warning when the override matches the lock', async () => {
    const tools = await resolveWhisperTools({
      paths: ws.paths,
      lock,
      overrides: overrideFiles(EXE, MODEL_A),
    });
    expect(tools.warnings).toEqual([]);
    expect(tools.modelId).toBe('model-a');
  });

  it('does not fall back when an override points at nothing', async () => {
    installBinary();
    installModel('ggml-a.bin', MODEL_A);
    await expect(
      resolveWhisperTools({
        paths: ws.paths,
        lock,
        overrides: { modelPath: path.join(ws.dir, 'gone.bin') },
      }),
    ).rejects.toMatchObject({ code: 'TOOLS_NOT_PROVISIONED' });
  });

  it('loads overrides.yaml, resolving relative paths against it', async () => {
    mkdirSync(ws.paths.whisperDir, { recursive: true });
    writeFileSync(ws.paths.whisperOverridesFile, 'schema_version: 1\nmodel_path: mine/x.bin\n');
    expect(await loadWhisperOverrides(ws.paths.whisperOverridesFile)).toEqual({
      binaryPath: undefined,
      modelPath: path.join(ws.paths.whisperDir, 'mine', 'x.bin'),
    });
  });

  it('treats a missing file as no overrides and rejects an invalid one', async () => {
    expect(await loadWhisperOverrides(ws.paths.whisperOverridesFile)).toEqual({});
    mkdirSync(ws.paths.whisperDir, { recursive: true });
    writeFileSync(ws.paths.whisperOverridesFile, 'schema_version: 1\nbinary: x\n');
    await expect(loadWhisperOverrides(ws.paths.whisperOverridesFile)).rejects.toMatchObject({
      code: 'TOOLS_OVERRIDES_INVALID',
    });
  });
});

describe('job inputs (acceptance: changing the model changes the transcription input hash)', () => {
  const inputs = async (active: string): Promise<ReturnType<typeof whisperJobInputs>> =>
    whisperJobInputs(
      await resolveWhisperTools({ paths: ws.paths, lock: withActive(active), overrides: {} }),
    );

  beforeEach(() => {
    installBinary();
    installModel('ggml-a.bin', MODEL_A);
    installModel('ggml-b.bin', MODEL_B);
  });

  it('expose the model and binary hashes', async () => {
    const [model, binary] = await inputs('model-a');
    expect(model).toEqual(modelInput('whisper-model/model-a', sha(MODEL_A)));
    expect(binary?.ref).toBe('whisper-binary');
  });

  it('the binary hash covers the DLLs, not just the executable', async () => {
    const before = await inputs('model-a');
    const dllSwapped = localBuildLock(server);
    const dll = Buffer.from('another dll');
    const files = dllSwapped.whisper.binary.files.map((f) =>
      f.path === 'whisper.dll' ? { ...f, sha256: sha(dll) } : f,
    );
    installBinary(EXE, dll);
    const tools = await resolveWhisperTools({
      paths: ws.paths,
      lock: {
        ...dllSwapped,
        whisper: { ...dllSwapped.whisper, binary: { ...dllSwapped.whisper.binary, files } },
      },
      overrides: {},
    });
    expect(whisperJobInputs(tools)[1]?.hash).not.toBe(before[1]?.hash);
  });

  it('reruns the transcribe stage when the model changes, and only then', async () => {
    const fx = await openFixture();
    const world = newWorld();
    const config = runConfig(campaign(), glossary());
    try {
      const run = (active: string) =>
        inputs(active).then((whisper) =>
          runStage({
            db: fx.db,
            campaignId: 'synthetic-vaults',
            sessionId: 's01',
            stage: 'transcribe',
            stages: pipelineStages(world, { transcribe: { inputs: () => whisper } }),
            paths: fx.paths,
            config,
            logger: fx.logger,
            sleep: noSleep,
          }),
        );
      const first = await run('model-a');
      expect(first.status).toBe('succeeded');

      const same = await run('model-a');
      expect(same.stages.find((s) => s.stage === 'transcribe')?.action).toBe('up-to-date');

      const changed = await run('model-b');
      const transcribe = changed.stages.find((s) => s.stage === 'transcribe');
      expect(transcribe?.action).toBe('succeeded');
      expect(transcribe?.changedInputs).toEqual(
        expect.arrayContaining(['model:whisper-model/model-a', 'model:whisper-model/model-b']),
      );
    } finally {
      fx.cleanup();
    }
  });
});

describe('recap doctor (whisper)', () => {
  async function doctor(active = lock): Promise<Awaited<ReturnType<typeof checkWhisper>>> {
    const lockFile = path.join(ws.dir, 'tools.lock.json');
    writeFileSync(lockFile, JSON.stringify(active));
    return checkWhisper(ws.paths.root, { lockFile, vulkan });
  }

  it('reports not-installed without failing --strict', async () => {
    const report = await doctor();
    expect(report.ok).toBe(true);
    const text = report.lines.join('\n');
    expect(text).toContain('whisper:  MISSING v1.9.5 (d1be6fd)');
    expect(text).toContain('model:    MISSING model-a');
    expect(text).toContain('fix: run `recap setup whisper`');
    expect(text).toContain('vulkan:   ok Fake GPU (discrete GPU)');
  });

  it('reports verified files', async () => {
    installBinary();
    installModel('ggml-a.bin', MODEL_A);
    const report = await doctor();
    expect(report.ok).toBe(true);
    const text = report.lines.join('\n');
    expect(text).toContain('whisper:  ok v1.9.5');
    expect(text).toContain('sha256: 2 files verified');
    expect(text).toContain('model:    ok model-a');
  });

  it('fails --strict on a hash mismatch, naming the bad file', async () => {
    installBinary(EXE, Buffer.from('swapped'));
    installModel('ggml-a.bin', MODEL_A);
    const report = await doctor();
    expect(report.ok).toBe(false);
    expect(report.lines.join('\n')).toContain('whisper.dll: mismatch');
    expect(report.lines.join('\n')).toContain('whisper:  HASH MISMATCH');
  });

  it('shows an override and its warning without failing --strict', async () => {
    mkdirSync(ws.paths.whisperDir, { recursive: true });
    const own = path.join(ws.dir, 'own.bin');
    writeFileSync(own, MODEL_B);
    writeFileSync(
      ws.paths.whisperOverridesFile,
      `schema_version: 1\nmodel_path: ${JSON.stringify(own)}\n`,
    );
    installBinary();
    const report = await doctor();
    expect(report.ok).toBe(true);
    const text = report.lines.join('\n');
    expect(text).toContain('model:    ok (differs from the lock) override');
    expect(text).toContain('(from override)');
    expect(text).toContain('warning: whisper model override does not match');
  });

  it('fails --strict on an override that points at nothing', async () => {
    mkdirSync(ws.paths.whisperDir, { recursive: true });
    writeFileSync(
      ws.paths.whisperOverridesFile,
      `schema_version: 1\nbinary_path: ${JSON.stringify(path.join(ws.dir, 'gone'))}\n`,
    );
    expect((await doctor()).ok).toBe(false);
  });

  it('reports an invalid lock instead of throwing', async () => {
    const lockFile = path.join(ws.dir, 'broken.json');
    writeFileSync(lockFile, '{');
    const report = await checkWhisper(ws.paths.root, { lockFile, vulkan });
    expect(report.ok).toBe(false);
    expect(report.lines.join('\n')).toContain('[TOOLS_LOCK_INVALID]');
  });

  it('skips the file checks without a usable data root', async () => {
    const report = await checkWhisper(undefined, { vulkan });
    expect(report.ok).toBe(true);
    expect(report.lines[0]).toContain('not checked');
  });
});

describe('vulkaninfo parsing', () => {
  const SUMMARY = [
    'Devices:',
    'GPU0:',
    '\tdeviceType         = PHYSICAL_DEVICE_TYPE_DISCRETE_GPU',
    '\tdeviceName         = AMD Radeon RX 9070 XT',
    'GPU1:',
    '\tdeviceType         = PHYSICAL_DEVICE_TYPE_INTEGRATED_GPU',
    '\tdeviceName         = AMD Radeon(TM) Graphics',
    '',
  ].join('\r\n');

  it('lists devices with their type', () => {
    expect(vulkanStatusFromOutput(SUMMARY)).toEqual({
      state: 'found',
      devices: [
        { name: 'AMD Radeon RX 9070 XT', type: 'discrete GPU' },
        { name: 'AMD Radeon(TM) Graphics', type: 'integrated GPU' },
      ],
    });
  });

  it('does not count a software CPU device as a GPU', () => {
    const text = '\tdeviceType = PHYSICAL_DEVICE_TYPE_CPU\n\tdeviceName = llvmpipe\n';
    expect(vulkanStatusFromOutput(text)).toEqual({
      state: 'no-gpu',
      devices: [{ name: 'llvmpipe', type: 'CPU' }],
    });
  });
});
