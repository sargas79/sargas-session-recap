import { Type, type Static, type SchemaOptions } from '@sinclair/typebox';
import { Count, Hash, RelPath, SchemaVersion1, Slug } from '../common.ts';

/** One path segment: a file or directory name, never a path. */
const FileName = (options: SchemaOptions = {}) =>
  Type.String({ pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$', ...options });

const Url = (options: SchemaOptions = {}) =>
  Type.String({ pattern: '^https?://[^\\s]+$', maxLength: 2048, ...options });

const LockedFile = Type.Object(
  { path: RelPath(), sha256: Hash() },
  { additionalProperties: false },
);

/** Fields shared by every way of obtaining the whisper.cpp binary. */
const binaryFields = {
  platform: Type.String({
    pattern: '^[a-z0-9]+-[a-z0-9]+$',
    description: 'Node `<platform>-<arch>` this binary runs on, e.g. `win32-x64`.',
  }),
  install_dir: FileName({
    description: 'Directory name under `<data-root>/tools/whisper/`.',
  }),
  executable: RelPath({ description: 'Entry of `files` that is the CLI to run.' }),
  files: Type.Array(LockedFile, {
    minItems: 1,
    maxItems: 64,
    description:
      'Every file the binary needs, relative to `install_dir`, including the DLLs it loads. All are hash-checked.',
  }),
};

const LocalBuildBinary = Type.Object(
  {
    source: Type.Literal('local-build'),
    ...binaryFields,
    build: Type.Object(
      {
        repository: Url(),
        flags: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 32 }),
      },
      {
        additionalProperties: false,
        description: 'How the pinned binary was built. Rebuilds are not byte-reproducible.',
      },
    ),
  },
  { additionalProperties: false },
);

const ArchiveBinary = Type.Object(
  {
    source: Type.Literal('archive'),
    ...binaryFields,
    archive: Type.Object(
      { url: Url(), sha256: Hash(), bytes: Count({ minimum: 1 }) },
      { additionalProperties: false, description: 'Zip archive holding `files`.' },
    ),
  },
  { additionalProperties: false },
);

const WhisperModel = Type.Object(
  {
    id: Slug({ description: 'Model name, e.g. `large-v3-turbo`.' }),
    file: FileName({ description: 'File name under `<data-root>/tools/whisper/models/`.' }),
    url: Url(),
    sha256: Hash(),
    bytes: Count({ minimum: 1 }),
  },
  { additionalProperties: false },
);

/**
 * `tools.lock.json` (T23): the pinned whisper.cpp binary and models. Committed; holds hashes and
 * URLs only, never the files. Edit `active_model` to change the model the pipeline uses.
 */
export const ToolsLockSchema = Type.Object(
  {
    schema_version: SchemaVersion1,
    whisper: Type.Object(
      {
        version: Type.String({ pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' }),
        commit: Type.String({ pattern: '^[0-9a-f]{40}$' }),
        binary: Type.Union([LocalBuildBinary, ArchiveBinary]),
        active_model: Slug({ description: 'The `id` of the entry of `models` to use.' }),
        models: Type.Array(WhisperModel, { minItems: 1, maxItems: 32 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type ToolsLock = Static<typeof ToolsLockSchema>;
export type WhisperBinaryLock = ToolsLock['whisper']['binary'];
export type WhisperModelLock = ToolsLock['whisper']['models'][number];

/**
 * `<data-root>/tools/whisper/overrides.yaml` (T23): operator-supplied paths on this machine. Relative
 * values resolve against the file's directory. Overridden files are hash-checked against the lock;
 * a mismatch is a warning, not an error.
 */
export const WhisperOverridesSchema = Type.Object(
  {
    schema_version: SchemaVersion1,
    binary_path: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 1024,
        description: 'Path to the whisper-cli binary.',
      }),
    ),
    model_path: Type.Optional(
      Type.String({ minLength: 1, maxLength: 1024, description: 'Path to the ggml model file.' }),
    ),
  },
  { additionalProperties: false },
);
export type WhisperOverrides = Static<typeof WhisperOverridesSchema>;
