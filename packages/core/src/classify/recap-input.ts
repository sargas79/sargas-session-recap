import type { ClassificationLabel } from '@sargas-recap/contracts';

export type DefaultRecapInclusion = 'include' | 'exclude' | 'unresolved';

/**
 * Whether a segment goes to the recap before any GM decision (T12 builds the projection, T13
 * consumes it). OOC is kept in the results but excluded by default; `mixed` and `uncertain` wait
 * for the GM.
 */
export function defaultRecapInclusion(label: ClassificationLabel): DefaultRecapInclusion {
  switch (label) {
    case 'ic':
    case 'narration':
    case 'rules':
      return 'include';
    case 'ooc':
      return 'exclude';
    case 'mixed':
    case 'uncertain':
      return 'unresolved';
  }
}
