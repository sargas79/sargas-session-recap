import { stat } from 'node:fs/promises';
import path from 'node:path';
import { AudioToolError } from './errors.ts';

/**
 * Resolves `input` to an absolute path and checks that it is a readable file.
 * Absolute paths can never be mistaken for an ffmpeg option (`-foo`).
 */
export async function resolveInputFile(input: string): Promise<string> {
  if (input.length === 0) {
    throw new AudioToolError('AUDIO_INVALID_ARGUMENT', 'input path is empty');
  }
  const resolved = path.resolve(input);
  const isFile = await stat(resolved).then(
    (info) => info.isFile(),
    () => false,
  );
  if (!isFile) {
    throw new AudioToolError('AUDIO_INVALID_ARGUMENT', `input file not found: ${resolved}`, {
      hint: 'check the path; quote it in your shell if it contains spaces',
    });
  }
  return resolved;
}
