/**
 * Multitrack recording import (T05): one audio file per speaker -> a sealed session package.
 *
 * Steps, each of which fails closed:
 * 1. Load campaign.yaml (T04) and the track -> speaker mapping (`recap-tracks.yaml`, `.yml`,
 *    `.json` next to the tracks, or `--mapping`).
 * 2. Every mapped track must exist in the import directory. Audio files the mapping does not list
 *    are excluded and reported (`unmapped`).
 * 3. `assertConsent(stage: 'recording')` for every mapped speaker. Speakers it refuses (no record,
 *    withdrawn, not in campaign.yaml, ...) are excluded with the refusal reason; the rest are
 *    checked again so the package carries a receipt for exactly the speakers it contains.
 * 4. Each original is hashed, probed, copied byte for byte into `audio/<speaker_id>/<n>.<ext>`,
 *    the copy is hashed, and after all copies the originals are hashed again. Any difference is
 *    an error: originals are never modified, and a package never holds a partial copy.
 * 5. `fragments.jsonl` (ADR-003 offsets) and `manifest.json` (consent snapshot from the receipt)
 *    are written, the package is sealed with `sealPackage` and validated with `validatePackage`,
 *    the same validator the Discord bot's packages must pass (ADR-006).
 * 6. The package is built in a temp directory next to the session directory and renamed into
 *    place only when complete, so a failed import never leaves a half-written session.
 *
 * No Discord, Foundry, network or database is involved. ffprobe is needed only for non-WAV
 * tracks (16-bit PCM WAV headers are read in JS).
 */
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  CampaignConfig,
  Fragment,
  ImportMapping,
  ImportMappingTrack,
  Manifest,
} from '@sargas-recap/contracts';
import { probeAudio, type AudioProbe, type ProbeOptions } from '../audio/index.ts';
import {
  assertConsent,
  isConsentError,
  loadCampaignConfig,
  loadImportMapping,
  type ConsentReceipt,
  type ConsentRefusalReason,
} from '../config/index.ts';
import type { Logger } from '../log/index.ts';
import {
  FRAGMENTS_FILE,
  finalizeDirectory,
  renameWithRetry,
  sealPackage,
  sha256File,
  tempDirFor,
  tempPathFor,
  validatePackage,
  writeFileAtomic,
  writeManifest,
  type PackageReport,
} from '../package/index.ts';
import type { DataPaths } from '../paths/index.ts';
import { ImportError } from './errors.ts';
import { newUlid } from './ulid.ts';
import { probeWavHeader } from './wav.ts';

/** Mapping file names looked up in the import directory when `--mapping` is not given. */
export const MAPPING_FILE_NAMES = Object.freeze([
  'recap-tracks.yaml',
  'recap-tracks.yml',
  'recap-tracks.json',
]);

/** Extensions treated as audio when looking for unmapped tracks. */
export const AUDIO_EXTENSIONS: ReadonlySet<string> = new Set([
  'wav',
  'flac',
  'ogg',
  'oga',
  'opus',
  'webm',
  'mka',
  'mp3',
  'm4a',
  'aac',
  'aiff',
  'wma',
]);

/** Extensions kept as-is in the package; anything else gets the codec's default extension. */
const PACKAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  'wav',
  'flac',
  'ogg',
  'oga',
  'opus',
  'webm',
  'mka',
]);

/** Codecs the fragment contract accepts, with their default package extension. */
const SUPPORTED_CODECS: Readonly<Record<string, string>> = {
  pcm_s16le: 'wav',
  flac: 'flac',
  opus: 'ogg',
};

type FragmentCodec = Fragment['codec'];

const MIN_SAMPLE_RATE = 8000;
const MAX_SAMPLE_RATE = 192_000;
const MAX_CHANNELS = 8;

/** Lifecycles whose package holds derived work or purged audio: never replaced by an import. */
const IN_USE_LIFECYCLES = new Set(['processing', 'retained', 'audio-purged']);
const DERIVED_DIRS = ['transcript', 'classify', 'recap'] as const;

/** Probes one track. The default reads WAV headers in JS and uses ffprobe for anything else. */
export type TrackProbe = (file: string) => Promise<AudioProbe>;

export interface ImportHooks {
  /** Runs right after a track was copied (tests use it to simulate a source that changes). */
  readonly afterCopy?: (source: string) => void | Promise<void>;
}

export interface ImportOptions {
  /** Directory with the tracks (one file per speaker). */
  readonly dir: string;
  readonly campaignId: string;
  readonly sessionId: string;
  /** Data root layout (ADR-009); the package goes to `paths.sessionDir(campaign, session)`. */
  readonly paths: DataPaths;
  /** Mapping file. Default: `recap-tracks.yaml|.yml|.json` in `dir`. */
  readonly mappingFile?: string | undefined;
  /** campaign.yaml. Default: `paths.campaignConfigFile(campaignId)`. */
  readonly campaignFile?: string | undefined;
  /**
   * Replace an existing package of this session. Only a package that was not processed yet
   * (`capturing`/`sealed`, no transcript/classify/recap directories) can be replaced. The CLI asks
   * for confirmation first.
   */
  readonly replace?: boolean | undefined;
  /** Recorded as `manifest.source.tool_version`. */
  readonly toolVersion: string;
  readonly probe?: TrackProbe | undefined;
  /** ffprobe lookup options for the default probe. */
  readonly audio?: ProbeOptions | undefined;
  readonly now?: (() => Date) | undefined;
  readonly logger?: Logger | undefined;
  readonly hooks?: ImportHooks | undefined;
}

export interface ImportedTrack {
  /** File name in the import directory. */
  readonly file: string;
  readonly speakerId: string;
  readonly fragmentId: string;
  /** Package-relative path of the copy. */
  readonly path: string;
  readonly codec: FragmentCodec;
  readonly durationMs: number;
  readonly startOffsetMs: number;
  readonly timingUncertaintyMs: number;
  /** `sha256:<hex>` of the original, equal to the copy's hash. */
  readonly hash: string;
}

export type ExclusionReason = 'unmapped' | ConsentRefusalReason;

export interface ExcludedTrack {
  readonly file: string;
  /** The mapped speaker (absent for unmapped files). */
  readonly speakerId?: string;
  readonly reason: ExclusionReason;
}

export interface ImportResult {
  readonly packageDir: string;
  readonly packageId: string;
  readonly campaignId: string;
  readonly sessionId: string;
  readonly imported: readonly ImportedTrack[];
  readonly excluded: readonly ExcludedTrack[];
  readonly consent: ConsentReceipt;
  /** True when an existing package was replaced. */
  readonly replaced: boolean;
  /** Validation report of the final package (state `sealed`). */
  readonly report: PackageReport;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

async function pathExists(target: string): Promise<boolean> {
  return lstat(target).then(
    () => true,
    (error: unknown) => {
      if (errorCode(error) === 'ENOENT') return false;
      throw error;
    },
  );
}

function extensionOf(name: string): string {
  return path.extname(name).slice(1).toLowerCase();
}

/** The default probe: JS WAV header reader first, ffprobe for anything it does not handle. */
export function defaultTrackProbe(audio: ProbeOptions = {}): TrackProbe {
  return async (file) => {
    if (extensionOf(file) === 'wav') {
      const wav = await probeWavHeader(file);
      if (wav !== undefined) return wav;
    }
    return probeAudio(file, audio);
  };
}

async function assertImportDir(dir: string): Promise<void> {
  const info = await stat(dir).catch(() => undefined);
  if (info?.isDirectory() !== true) {
    throw new ImportError(
      'IMPORT_DIR_NOT_FOUND',
      `import directory not found: ${dir}`,
      'pass the folder that holds the per-speaker tracks; quote it if it contains spaces',
    );
  }
}

async function findMappingFile(dir: string): Promise<string> {
  const found: string[] = [];
  for (const name of MAPPING_FILE_NAMES) {
    const candidate = path.join(dir, name);
    if ((await stat(candidate).catch(() => undefined))?.isFile() === true) found.push(candidate);
  }
  const [only, ...rest] = found;
  if (only === undefined) {
    throw new ImportError(
      'IMPORT_MAPPING_NOT_FOUND',
      `no track mapping found in ${dir} (looked for ${MAPPING_FILE_NAMES.join(', ')})`,
      'create recap-tracks.yaml next to the tracks (see docs/setup-windows.md, "Importing a recording") or pass --mapping <file>',
    );
  }
  if (rest.length > 0) {
    throw new ImportError(
      'IMPORT_MAPPING_AMBIGUOUS',
      `more than one track mapping in ${dir}`,
      `keep only one of ${MAPPING_FILE_NAMES.join(', ')}, or pass --mapping <file>`,
    );
  }
  return only;
}

/**
 * Refuses when the session already has a package, unless `replace` is set and the package has not
 * been processed. Returns whether a package exists.
 */
async function checkExistingSession(
  sessionDir: string,
  campaignId: string,
  sessionId: string,
  replace: boolean,
): Promise<boolean> {
  if (!(await pathExists(sessionDir))) return false;
  if (!replace) {
    throw new ImportError(
      'IMPORT_SESSION_EXISTS',
      `session ${sessionId} of campaign ${campaignId} already has a package: ${sessionDir}`,
      'import into a new --session id, or pass --replace to replace a package that has not been processed yet',
    );
  }
  const report = await validatePackage(sessionDir);
  const lifecycle = report.manifest?.lifecycle;
  let derived = false;
  for (const name of DERIVED_DIRS) {
    if (await pathExists(path.join(sessionDir, name))) derived = true;
  }
  if (derived || (lifecycle !== undefined && IN_USE_LIFECYCLES.has(lifecycle))) {
    throw new ImportError(
      'IMPORT_SESSION_IN_USE',
      `session ${sessionId} of campaign ${campaignId} has been processed (transcripts, classifications, recaps or purged audio); an import never replaces it`,
      'import into a new --session id',
    );
  }
  return true;
}

interface PlannedTrack {
  readonly index: number;
  readonly track: ImportMappingTrack;
  readonly source: string;
}

async function resolveMappedTracks(
  dir: string,
  mapping: ImportMapping,
  mappingLabel: string,
): Promise<PlannedTrack[]> {
  const planned: PlannedTrack[] = [];
  for (const [index, track] of mapping.tracks.entries()) {
    const source = path.join(dir, track.file);
    const info = await lstat(source).catch(() => undefined);
    const where = `${mappingLabel} /tracks/${String(index)}/file`;
    if (info === undefined) {
      throw new ImportError(
        'IMPORT_TRACK_MISSING',
        `${where}: the track is not in the import directory ${dir}`,
        'check the file name in the mapping (names are case-sensitive on Linux), or remove the entry',
      );
    }
    if (!info.isFile()) {
      throw new ImportError(
        'IMPORT_TRACK_MISSING',
        `${where}: the track is not a regular file (links and folders are not imported)`,
        'copy the real audio file into the import directory',
      );
    }
    planned.push({ index, track, source });
  }
  return planned;
}

async function findUnmapped(dir: string, mapping: ImportMapping): Promise<ExcludedTrack[]> {
  const mapped = new Set(mapping.tracks.map((t) => t.file.toLowerCase()));
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && AUDIO_EXTENSIONS.has(extensionOf(e.name)))
    .filter((e) => !mapped.has(e.name.toLowerCase()))
    .map((e) => e.name)
    .sort()
    .map((file) => ({ file, reason: 'unmapped' as const }));
}

interface ConsentOutcome {
  readonly receipt: ConsentReceipt;
  readonly refused: ReadonlyMap<string, ConsentRefusalReason>;
}

/**
 * `assertConsent(stage: 'recording')` for every mapped speaker. Refused speakers are excluded and
 * the remaining ones are asserted again, so the receipt covers exactly what is imported. A
 * provider mismatch refuses the whole import (consent is per provider).
 */
function checkRecordingConsent(
  campaign: CampaignConfig,
  provider: string,
  speakerIds: readonly string[],
  now: Date,
): ConsentOutcome {
  const input = { campaign, provider, stage: 'recording' as const, now };
  try {
    return { receipt: assertConsent({ ...input, speakerIds }), refused: new Map() };
  } catch (error) {
    if (!isConsentError(error) || error.code !== 'CONSENT_MISSING') throw error;
    const refused = new Map(error.refusals.map((r) => [r.speaker_id, r.reason]));
    const remaining = speakerIds.filter((id) => !refused.has(id));
    if (remaining.length === 0) {
      throw new ImportError(
        'IMPORT_NO_TRACKS',
        `no track can be imported: ${error.message}`,
        'fix the speakers in campaign.yaml or the mapping and import again',
      );
    }
    return { receipt: assertConsent({ ...input, speakerIds: remaining }), refused };
  }
}

function checkProbe(probe: AudioProbe, where: string): FragmentCodec {
  const hint =
    'convert the track losslessly to FLAC (`ffmpeg -i <track> -c:a flac <track>.flac`) or 16-bit WAV and map the converted file';
  if (!(probe.codec in SUPPORTED_CODECS)) {
    throw new ImportError(
      'IMPORT_TRACK_UNSUPPORTED',
      `${where}: codec ${probe.codec} is not supported (supported: ${Object.keys(SUPPORTED_CODECS).join(', ')})`,
      hint,
    );
  }
  if (probe.sampleRate < MIN_SAMPLE_RATE || probe.sampleRate > MAX_SAMPLE_RATE) {
    throw new ImportError(
      'IMPORT_TRACK_UNSUPPORTED',
      `${where}: sample rate ${String(probe.sampleRate)} Hz is outside ${String(MIN_SAMPLE_RATE)}-${String(MAX_SAMPLE_RATE)} Hz`,
      hint,
    );
  }
  if (probe.channels < 1 || probe.channels > MAX_CHANNELS) {
    throw new ImportError(
      'IMPORT_TRACK_UNSUPPORTED',
      `${where}: ${String(probe.channels)} channels are not supported (1-${String(MAX_CHANNELS)})`,
      hint,
    );
  }
  return probe.codec as FragmentCodec;
}

function packageExtension(file: string, codec: FragmentCodec): string {
  const ext = extensionOf(file);
  return PACKAGE_EXTENSIONS.has(ext) ? ext : (SUPPORTED_CODECS[codec] ?? 'bin');
}

/** Orders tracks per speaker by start offset, then mapping order, and numbers them from 1. */
function numberTracks(tracks: readonly PlannedTrack[]): Map<PlannedTrack, number> {
  const bySpeaker = new Map<string, PlannedTrack[]>();
  for (const t of tracks) {
    const list = bySpeaker.get(t.track.speaker_id) ?? [];
    list.push(t);
    bySpeaker.set(t.track.speaker_id, list);
  }
  const numbers = new Map<PlannedTrack, number>();
  for (const list of bySpeaker.values()) {
    list
      .sort(
        (a, b) =>
          (a.track.start_offset_ms ?? 0) - (b.track.start_offset_ms ?? 0) || a.index - b.index,
      )
      .forEach((t, i) => numbers.set(t, i + 1));
  }
  return numbers;
}

const sourceChanged = (where: string): ImportError =>
  new ImportError(
    'IMPORT_SOURCE_CHANGED',
    `${where}: the original changed while it was being imported, or its copy differs from it`,
    'make sure no recorder or sync tool is still writing the tracks, then import again',
  );

async function removeQuietly(target: string): Promise<void> {
  await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(
    () => undefined,
  );
}

/** Imports a multitrack recording as a sealed, validated session package. */
export async function importRecording(options: ImportOptions): Promise<ImportResult> {
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const { campaignId, sessionId, paths } = options;
  // Slug checks (PATHS_INVALID_ID) before touching anything.
  const sessionDir = paths.sessionDir(campaignId, sessionId);
  const sessionsDir = paths.sessionsDir(campaignId);
  const dir = path.resolve(options.dir);
  await assertImportDir(dir);

  const campaignFile = options.campaignFile ?? paths.campaignConfigFile(campaignId);
  const campaign = (await loadCampaignConfig(campaignFile)).value;
  if (campaign.campaign_id !== campaignId) {
    throw new ImportError(
      'IMPORT_CAMPAIGN_MISMATCH',
      `${campaignFile} /campaign_id does not match --campaign ${campaignId}`,
      'pass the campaign.yaml of this campaign with --config, or fix --campaign',
    );
  }
  const mappingFile =
    options.mappingFile === undefined
      ? await findMappingFile(dir)
      : path.resolve(options.mappingFile);
  const mapping = (await loadImportMapping(mappingFile)).value;
  const replace = options.replace === true;
  await checkExistingSession(sessionDir, campaignId, sessionId, replace);

  const planned = await resolveMappedTracks(dir, mapping, mappingFile);
  const excluded: ExcludedTrack[] = await findUnmapped(dir, mapping);

  const provider = mapping.recorder ?? campaign.provider.recording;
  const speakerIds = [...new Set(planned.map((t) => t.track.speaker_id))];
  const { receipt, refused } = checkRecordingConsent(campaign, provider, speakerIds, startedAt);
  for (const t of planned) {
    const reason = refused.get(t.track.speaker_id);
    if (reason !== undefined) {
      excluded.push({ file: t.track.file, speakerId: t.track.speaker_id, reason });
    }
  }
  const accepted = planned.filter((t) => !refused.has(t.track.speaker_id));

  // Hash and probe every original before anything is written.
  const probe = options.probe ?? defaultTrackProbe(options.audio);
  const facts = new Map<PlannedTrack, { hash: string; probe: AudioProbe; codec: FragmentCodec }>();
  for (const t of accepted) {
    const where = `${mappingFile} /tracks/${String(t.index)}/file`;
    const digest = await sha256File(t.source);
    const probed = await probe(t.source);
    facts.set(t, { hash: digest.hash, probe: probed, codec: checkProbe(probed, where) });
  }

  await mkdir(sessionsDir, { recursive: true });
  const temp = tempDirFor(sessionDir);
  await mkdir(temp);
  let finalized = false;
  try {
    const numbers = numberTracks(accepted);
    const imported: ImportedTrack[] = [];
    const fragments: Fragment[] = [];
    const ordered = [...accepted].sort(
      (a, b) =>
        (a.track.speaker_id < b.track.speaker_id
          ? -1
          : a.track.speaker_id > b.track.speaker_id
            ? 1
            : 0) || (numbers.get(a) ?? 0) - (numbers.get(b) ?? 0),
    );
    for (const t of ordered) {
      const fact = facts.get(t);
      const n = numbers.get(t);
      if (fact === undefined || n === undefined) throw new Error('import plan is inconsistent');
      const where = `${mappingFile} /tracks/${String(t.index)}/file`;
      const speaker = t.track.speaker_id;
      const rel = `audio/${speaker}/${String(n)}.${packageExtension(t.track.file, fact.codec)}`;
      const dest = path.join(temp, ...rel.split('/'));
      await mkdir(path.dirname(dest), { recursive: true });
      // COPYFILE_EXCL: never overwrite; the original is only ever read.
      await copyFile(t.source, dest, constants.COPYFILE_EXCL);
      await options.hooks?.afterCopy?.(t.source);
      if ((await sha256File(dest)).hash !== fact.hash) throw sourceChanged(where);

      const { sampleRate, sampleCount, channels } = fact.probe;
      const startOffsetMs = t.track.start_offset_ms ?? 0;
      const timingUncertaintyMs =
        t.track.timing_uncertainty_ms ?? mapping.default_timing_uncertainty_ms ?? 0;
      const durationMs = Math.floor((sampleCount * 1000) / sampleRate);
      fragments.push({
        schema_version: 1,
        fragment_id: `${speaker}:${String(n)}`,
        speaker_id: speaker,
        track_label: t.track.label ?? t.track.file.slice(0, 128),
        path: rel,
        codec: fact.codec,
        sample_rate_hz: sampleRate,
        channels,
        sample_count: sampleCount,
        duration_ms: durationMs,
        fragment_start_offset_ms: startOffsetMs,
        timing_uncertainty_ms: timingUncertaintyMs,
        status: 'complete',
      });
      imported.push({
        file: t.track.file,
        speakerId: speaker,
        fragmentId: `${speaker}:${String(n)}`,
        path: rel,
        codec: fact.codec,
        durationMs,
        startOffsetMs,
        timingUncertaintyMs,
        hash: fact.hash,
      });
    }
    // The originals must be byte-identical after the import (hash before == copy == after).
    for (const t of accepted) {
      const after = await sha256File(t.source);
      if (after.hash !== facts.get(t)?.hash) {
        throw sourceChanged(`${mappingFile} /tracks/${String(t.index)}/file`);
      }
    }

    await writeFileAtomic(
      path.join(temp, FRAGMENTS_FILE),
      fragments.map((f) => JSON.stringify(f)).join('\n') + '\n',
    );
    const recordedAt = startedAt.toISOString();
    const packageId = newUlid(startedAt.getTime());
    const manifest: Manifest = {
      schema_version: 1,
      campaign_id: campaignId,
      session_id: sessionId,
      package_id: packageId,
      created_at: recordedAt,
      lifecycle: 'capturing',
      source: { kind: 'multitrack-import', tool_version: options.toolVersion },
      timeline: {
        origin: 'provisional',
        origin_uncertainty_ms: mapping.origin_uncertainty_ms ?? 0,
        discontinuities: [],
      },
      consent: receipt.speaker_ids.map((speakerId) => ({
        speaker_id: speakerId,
        scopes: [receipt.stage],
        policy_hash: receipt.policy_hash,
        mode: receipt.mode,
        provider: receipt.provider,
        recorded_at: recordedAt,
      })),
    };
    await writeManifest(temp, manifest);
    await sealPackage(temp, { now });

    // Re-check right before the swap: another import may have created the session meanwhile.
    const exists = await checkExistingSession(sessionDir, campaignId, sessionId, replace);
    if (exists) {
      const old = tempPathFor(sessionDir);
      await renameWithRetry(sessionDir, old);
      try {
        await finalizeDirectory(temp, sessionDir);
      } catch (error) {
        await renameWithRetry(old, sessionDir);
        throw error;
      }
      finalized = true;
      await removeQuietly(old);
    } else {
      await finalizeDirectory(temp, sessionDir);
      finalized = true;
    }

    const report = await validatePackage(sessionDir);
    if (!report.ok || report.state !== 'sealed') {
      throw new ImportError(
        'IMPORT_PACKAGE_INVALID',
        `the imported package does not validate (${report.state}); run \`recap package validate ${sessionDir}\` for details`,
        'this is a bug; please report it with the validation output (it contains no audio or config values)',
      );
    }
    options.logger?.info('import.completed', {
      command: 'import',
      campaignId,
      sessionId,
      count: imported.length,
      status: report.state,
    });
    if (excluded.length > 0) {
      options.logger?.warn('import.excluded', {
        command: 'import',
        campaignId,
        sessionId,
        count: excluded.length,
      });
    }
    return {
      packageDir: sessionDir,
      packageId,
      campaignId,
      sessionId,
      imported,
      excluded,
      consent: receipt,
      replaced: exists,
      report,
    };
  } finally {
    if (!finalized) await removeQuietly(temp);
  }
}
