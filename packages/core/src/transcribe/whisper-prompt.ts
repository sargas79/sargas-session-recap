import type { AsrPromptTerm } from '../config/index.ts';

export interface WhisperPrompt {
  /** Empty when there is nothing to send: the runner then omits `--prompt`. */
  readonly text: string;
  readonly termsUsed: number;
  readonly termsDropped: number;
}

const SEPARATOR = ', ';

/**
 * The whisper initial prompt: the glossary spellings (T04's order) separated by commas. whisper
 * keeps only about 224 tokens of prompt, so terms past `maxChars` stay out, and are counted.
 */
export function buildWhisperPrompt(
  terms: readonly AsrPromptTerm[],
  maxChars: number,
): WhisperPrompt {
  const spellings = [...new Set(terms.map((term) => term.spelling))];
  let text = '';
  let termsUsed = 0;
  for (const spelling of spellings) {
    const next = text === '' ? spelling : `${text}${SEPARATOR}${spelling}`;
    if (next.length > maxChars) break;
    text = next;
    termsUsed += 1;
  }
  return { text, termsUsed, termsDropped: spellings.length - termsUsed };
}

export interface PromptDelivery {
  /** What reaches whisper. */
  readonly text: string;
  /** Pass the arguments through a `@file` instead of the command line. */
  readonly responseFile: boolean;
  /** The text lost its accents because no safe route exists (see below). */
  readonly folded: boolean;
}

const isAscii = (text: string): boolean => /^[ -~]*$/.test(text);

function foldToAscii(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^ -~]/g, '');
}

/**
 * How to hand whisper a prompt with accents. On Windows, whisper-cli v1.9.5 takes its command line
 * in the ANSI code page (examples/cli/cli.cpp, `main`) but tokenizes the prompt as UTF-8, so é on
 * the command line would be mangled. It reads a `@file` as raw bytes, so UTF-8 text survives
 * there, but paths in such a file then are UTF-8 too and only work if they are ASCII. With
 * non-ASCII paths the prompt falls back to unaccented text, as S04 step 6 prescribes.
 */
export function planPromptDelivery(
  text: string,
  pathsInArguments: readonly string[],
  platform: NodeJS.Platform,
): PromptDelivery {
  if (platform !== 'win32' || isAscii(text)) return { text, responseFile: false, folded: false };
  if (pathsInArguments.every(isAscii)) return { text, responseFile: true, folded: false };
  return { text: foldToAscii(text), responseFile: false, folded: true };
}
