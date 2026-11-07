/**
 * Typed errors for the audio toolchain.
 *
 * Every error carries a stable `code` and, where the operator can do something
 * about it, a `hint` with the fix. Messages never contain file contents or full
 * subprocess output. `detail` may carry a short, truncated stderr tail for
 * debugging; it is never logged by this module.
 */

export type AudioToolName = 'ffmpeg' | 'ffprobe';

export type AudioErrorCode =
  | 'AUDIO_TOOL_NOT_FOUND'
  | 'AUDIO_TOOL_TOO_OLD'
  | 'AUDIO_TOOL_UNRECOGNIZED'
  | 'AUDIO_TIMEOUT'
  | 'AUDIO_ABORTED'
  | 'AUDIO_PROCESS_FAILED'
  | 'AUDIO_OUTPUT_TOO_LARGE'
  | 'AUDIO_PARSE_FAILED'
  | 'AUDIO_NO_AUDIO_STREAM'
  | 'AUDIO_INVALID_ARGUMENT'
  | 'AUDIO_WRITE_FAILED';

export interface AudioToolErrorOptions {
  readonly tool?: AudioToolName | undefined;
  readonly hint?: string | undefined;
  readonly exitCode?: number | null | undefined;
  readonly detail?: string | undefined;
  readonly cause?: unknown;
}

export class AudioToolError extends Error {
  readonly code: AudioErrorCode;
  readonly tool: AudioToolName | undefined;
  readonly hint: string | undefined;
  readonly exitCode: number | null | undefined;
  readonly detail: string | undefined;

  constructor(code: AudioErrorCode, message: string, options: AudioToolErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AudioToolError';
    this.code = code;
    this.tool = options.tool;
    this.hint = options.hint;
    this.exitCode = options.exitCode;
    this.detail = options.detail;
  }

  /** Message plus fix hint, suitable for printing to an operator. */
  toUserMessage(): string {
    return this.hint === undefined ? this.message : `${this.message}\n  fix: ${this.hint}`;
  }
}

export function isAudioToolError(value: unknown): value is AudioToolError {
  return value instanceof AudioToolError;
}

/** Install hint shown whenever ffmpeg/ffprobe is missing or unusable. */
export function installHint(tool: AudioToolName): string {
  const envVar = tool === 'ffmpeg' ? 'RECAP_FFMPEG' : 'RECAP_FFPROBE';
  return (
    `install FFmpeg (Windows: \`winget install Gyan.FFmpeg\`, then open a new terminal; ` +
    `Ubuntu: \`sudo apt install ffmpeg\`) or set ${envVar} to the full path of ${tool}. ` +
    'Verify with `recap doctor`. See docs/setup-windows.md.'
  );
}
