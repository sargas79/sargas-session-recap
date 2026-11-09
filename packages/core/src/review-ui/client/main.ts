/// <reference lib="dom" />
/**
 * The small browser client of the review screen (T14), bundled by esbuild. The page works without
 * it: this adds filters, j/k navigation, a warning before losing unsaved edits and a status poll
 * while a recap is generated. It reads only server-rendered attributes and writes only text.
 */
import { isTypingTarget, matchesFilter, moveIndex, reloadAfterGeneration } from './logic.ts';

const POLL_MS = 3_000;

const lines = Array.from(document.querySelectorAll<HTMLElement>('article.segment'));
const dirty = new Set<HTMLFormElement>();

function setUpFilters(): void {
  const bar = document.getElementById('filters');
  if (bar === null) return;
  bar.hidden = false;
  const buttons = Array.from(bar.querySelectorAll<HTMLButtonElement>('button[data-filter]'));
  for (const button of buttons) {
    button.addEventListener('click', () => {
      const filter = button.dataset['filter'] ?? 'all';
      for (const other of buttons) other.setAttribute('aria-pressed', String(other === button));
      for (const line of lines) {
        line.hidden = !matchesFilter(filter, {
          label: line.dataset['label'] ?? 'none',
          attention: line.dataset['attention'] === '1',
        });
      }
    });
  }
}

function setUpKeys(): void {
  let index = -1;
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'j' && event.key !== 'k') return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.target instanceof HTMLElement && isTypingTarget(event.target.tagName)) return;
    const visible = lines.filter((line) => !line.hidden);
    index = moveIndex(index, visible.length, event.key === 'j' ? 1 : -1);
    const line = visible[index];
    if (line !== undefined) window.location.hash = line.id;
  });
}

function setUpDirtyWarning(): void {
  for (const form of document.querySelectorAll<HTMLFormElement>('details.edit form')) {
    form.addEventListener('input', () => dirty.add(form));
    form.addEventListener('submit', () => dirty.delete(form));
  }
  window.addEventListener('beforeunload', (event) => {
    if (dirty.size > 0) event.preventDefault();
  });
}

function setUpGenerationPoll(): void {
  const status = document.getElementById('regen-status');
  if (status?.dataset['state'] !== 'running') return;
  const timer = window.setInterval(() => {
    void fetch('/api/recap/regeneration')
      .then((response) => response.json() as Promise<{ status: string }>)
      .then((state) => {
        if (state.status === 'running') return;
        window.clearInterval(timer);
        if (reloadAfterGeneration(state.status, dirty.size)) window.location.reload();
        else status.textContent = 'Generation finished: reload to see it.';
      });
  }, POLL_MS);
}

setUpFilters();
setUpKeys();
setUpDirtyWarning();
setUpGenerationPoll();
