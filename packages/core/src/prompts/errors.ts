export type PromptErrorCode =
  /** No prompt asset with that id (and version). */
  | 'PROMPT_NOT_FOUND'
  /** A prompt asset file is malformed: file name, front matter or template placeholders. */
  | 'PROMPT_INVALID'
  /** Render-time data does not match the prompt's declared data slots. */
  | 'PROMPT_DATA_INVALID';

/**
 * Error raised by the prompt registry and templating (T26). Messages name files, ids, versions and
 * slot names only; they never contain prompt text or transcript data.
 */
export class PromptError extends Error {
  readonly code: PromptErrorCode;

  constructor(code: PromptErrorCode, message: string) {
    super(message);
    this.name = 'PromptError';
    this.code = code;
  }
}

export function isPromptError(value: unknown): value is PromptError {
  return value instanceof PromptError;
}
