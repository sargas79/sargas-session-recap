/** The decisions of the review client, free of the DOM so they can be unit tested (T14). */

export interface LineFacts {
  readonly label: string;
  readonly attention: boolean;
}

/** `all`, `attention` or `label:<name>`. */
export function matchesFilter(filter: string, line: LineFacts): boolean {
  if (filter === 'attention') return line.attention;
  if (filter.startsWith('label:')) return line.label === filter.slice('label:'.length);
  return true;
}

/** The next position when moving by `delta`, starting before the first line when none is set. */
export function moveIndex(current: number, total: number, delta: 1 | -1): number {
  if (total === 0) return -1;
  const next = current === -1 ? (delta === 1 ? 0 : total - 1) : current + delta;
  return Math.min(total - 1, Math.max(0, next));
}

/** Keys that must keep typing in a field instead of moving through the transcript. */
export function isTypingTarget(tagName: string): boolean {
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(tagName.toUpperCase());
}

/** A finished generation refreshes the page unless that would lose text the GM is typing. */
export function reloadAfterGeneration(status: string, unsavedForms: number): boolean {
  return status !== 'running' && unsavedForms === 0;
}
