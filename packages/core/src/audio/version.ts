import type { AudioToolName } from './errors.ts';

/**
 * Minimum supported FFmpeg release for ffmpeg and ffprobe.
 *
 * Why 6.0:
 * - CI exercises 6.1 (Ubuntu 24.04 `apt`) and a current 7.x/8.x (Chocolatey on
 *   Windows), so 6.x is the oldest major line that is actually tested.
 * - 6.0 is the first major release after the channel-layout API migration
 *   finished in 5.1, so `-ac`, the ffprobe `channels` field and downmixing
 *   behave the same across every accepted version.
 * - 5.x and older are end-of-life upstream; distributions that still ship them
 *   (for example Ubuntu 22.04 with 4.4) are not tested and are rejected with an
 *   actionable message instead of producing subtly different output.
 *
 * Recommended: 7.0 or newer. Before 7.0, ffmpeg prints `silencedetect`
 * timestamps with only six significant digits, so on recordings longer than
 * about 16 minutes (1000 s) silence boundaries are only 10 ms precise, and past
 * about 2.8 hours (10000 s) only 100 ms precise. `recap doctor` points this out.
 */
export const MIN_FFMPEG_VERSION: ReleaseVersion = Object.freeze({ major: 6, minor: 0, patch: 0 });

/** Version from which silencedetect timestamps keep microsecond precision. */
export const RECOMMENDED_FFMPEG_VERSION: ReleaseVersion = Object.freeze({
  major: 7,
  minor: 0,
  patch: 0,
});

export interface ReleaseVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

export type ToolVersion =
  | {
      /** A numbered release, e.g. `7.1.1-full_build-www.gyan.dev` or `n7.0.2`. */
      readonly kind: 'release';
      readonly raw: string;
      readonly release: ReleaseVersion;
    }
  | {
      /**
       * A build from the development branch (`N-118000-g...`,
       * `2025-01-30-git-...`). These are newer than the latest release and are
       * accepted without a numeric check.
       */
      readonly kind: 'development';
      readonly raw: string;
    };

const HEADER_RE = /^(ffmpeg|ffprobe) version (\S+)/m;
const RELEASE_RE = /^n?(\d+)\.(\d+)(?:\.(\d+))?(?:[^\d.]|$)/;
const DEVELOPMENT_RE = /^(?:N-\d+|\d{4}-\d{2}-\d{2}-git|git-)/;

/**
 * Parses the first line of `ffmpeg -version` / `ffprobe -version` output.
 * Returns `undefined` when the output is not from the expected tool or the
 * version token is not recognized.
 */
export function parseToolVersion(output: string, tool: AudioToolName): ToolVersion | undefined {
  const header = HEADER_RE.exec(output);
  if (header?.[1] !== tool) {
    return undefined;
  }
  const raw = header[2] ?? '';
  const release = RELEASE_RE.exec(raw);
  if (release !== null) {
    return {
      kind: 'release',
      raw,
      release: {
        major: Number.parseInt(release[1] ?? '0', 10),
        minor: Number.parseInt(release[2] ?? '0', 10),
        patch: Number.parseInt(release[3] ?? '0', 10),
      },
    };
  }
  if (DEVELOPMENT_RE.test(raw)) {
    return { kind: 'development', raw };
  }
  return undefined;
}

export function compareVersions(a: ReleaseVersion, b: ReleaseVersion): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

export function formatVersion(version: ReleaseVersion): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}

/** True when the version is at least `minimum` (development builds always are). */
export function meetsMinimum(
  version: ToolVersion,
  minimum: ReleaseVersion = MIN_FFMPEG_VERSION,
): boolean {
  return version.kind === 'development' || compareVersions(version.release, minimum) >= 0;
}
