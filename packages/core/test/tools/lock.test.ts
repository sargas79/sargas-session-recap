import { describe, expect, it } from 'vitest';
import { activeModel, loadToolsLock, parseToolsLock } from '../../src/tools/index.ts';

const VALID = {
  schema_version: 1,
  whisper: {
    version: 'v1.9.5',
    commit: 'a'.repeat(40),
    binary: {
      source: 'local-build',
      platform: 'win32-x64',
      install_dir: 'v1.9.5-vulkan',
      executable: 'whisper-cli.exe',
      files: [{ path: 'whisper-cli.exe', sha256: `sha256:${'a'.repeat(64)}` }],
      build: { repository: 'https://github.com/ggml-org/whisper.cpp', flags: [] },
    },
    active_model: 'large-v3-turbo',
    models: [
      {
        id: 'large-v3-turbo',
        file: 'ggml-large-v3-turbo.bin',
        url: 'https://huggingface.co/x',
        sha256: `sha256:${'b'.repeat(64)}`,
        bytes: 1,
      },
    ],
  },
};

type Mutable = typeof VALID;

function parse(change: (lock: Mutable) => void): unknown {
  const copy = structuredClone(VALID);
  change(copy);
  return parseToolsLock(JSON.stringify(copy), 'tools.lock.json');
}

describe('committed tools.lock.json', () => {
  it('validates and pins what S04 recorded', async () => {
    const lock = await loadToolsLock();
    expect(lock.whisper.version).toBe('v1.9.5');
    expect(lock.whisper.commit).toBe('d1be6fde11ac6e0407606b4e42fe72d34add8037');
    expect(lock.whisper.binary.source).toBe('local-build');
    expect(lock.whisper.binary.files.map((f) => f.path).sort()).toEqual([
      'ggml-base.dll',
      'ggml-cpu.dll',
      'ggml-vulkan.dll',
      'ggml.dll',
      'whisper-cli.exe',
      'whisper.dll',
    ]);
    expect(lock.whisper.binary.files.find((f) => f.path === 'whisper-cli.exe')?.sha256).toBe(
      'sha256:8fa49e66747a619990debc91de01b9f1319af63dbbbe7c4a131a0714a84ab868',
    );
    const model = activeModel(lock);
    expect(model.id).toBe('large-v3-turbo');
    expect(model.bytes).toBe(1_624_555_275);
    expect(model.sha256).toBe(
      'sha256:1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69',
    );
    expect(lock.whisper.models.find((m) => m.id === 'large-v3')?.sha256).toBe(
      'sha256:64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2',
    );
  });
});

describe('lock rules', () => {
  it('accepts the baseline', () => {
    expect(parse(() => undefined)).toBeDefined();
  });

  it.each<[string, (lock: Mutable) => void]>([
    ['unknown active model', (l) => (l.whisper.active_model = 'nope')],
    [
      'plain http to a remote host',
      (l) => ((l.whisper.models[0] as { url: string }).url = 'http://example.com/m.bin'),
    ],
    [
      'credentials in the URL',
      (l) => ((l.whisper.models[0] as { url: string }).url = 'https://u:p@example.com/m.bin'),
    ],
    ['executable not listed', (l) => (l.whisper.binary.executable = 'other.exe')],
    [
      'duplicate base names',
      (l) =>
        l.whisper.binary.files.push(
          { path: 'a/ggml.dll', sha256: `sha256:${'c'.repeat(64)}` },
          { path: 'b/ggml.dll', sha256: `sha256:${'c'.repeat(64)}` },
        ),
    ],
    [
      'reserved Windows name',
      (l) => l.whisper.binary.files.push({ path: 'nul.dll', sha256: `sha256:${'c'.repeat(64)}` }),
    ],
    ['schema violation', (l) => (l.whisper.commit = 'short')],
  ])('rejects %s', (_name, change) => {
    expect(() => parse(change)).toThrow(expect.objectContaining({ code: 'TOOLS_LOCK_INVALID' }));
  });

  it('rejects malformed JSON', () => {
    expect(() => parseToolsLock('{', 'x')).toThrow(
      expect.objectContaining({ code: 'TOOLS_LOCK_INVALID' }),
    );
  });
});
