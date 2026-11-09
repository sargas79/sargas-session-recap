import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import {
  isTypingTarget,
  matchesFilter,
  moveIndex,
  reloadAfterGeneration,
} from '../../src/review-ui/client/logic.ts';
import { escapeHtml, html, SafeHtml } from '../../src/review-ui/html.ts';
import {
  hostAllowed,
  originAllowed,
  readCookie,
  stateChangeAllowed,
  tokenMatches,
} from '../../src/review-ui/security.ts';

describe('html template', () => {
  it('escapes every character that can leave a text node or a quoted attribute', () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&`)).toBe(
      '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;',
    );
  });

  it('escapes by default, in text and in attributes, also inside lists', () => {
    const evil = `"><script>alert(1)</script>`;
    expect(html`<p title="${evil}">${evil}</p>`.value).toBe(
      '<p title="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;">&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;</p>',
    );
    expect(html`${[evil, [evil]]}`.value).not.toContain('<script>');
  });

  it('keeps nested templates and drops empty values', () => {
    expect(html`<div>${html`<b>${'x<'}</b>`}${null}${undefined}${false}${0}</div>`.value).toBe(
      '<div><b>x&lt;</b>0</div>',
    );
    expect(new SafeHtml('<i>').toString()).toBe('<i>');
  });
});

describe('request checks', () => {
  it('accepts only the exact host and origin of this server', () => {
    expect(hostAllowed('127.0.0.1:4000', 4000)).toBe(true);
    for (const host of [undefined, 'evil.example', 'localhost:4000', '127.0.0.1:4001']) {
      expect(hostAllowed(host, 4000)).toBe(false);
    }
    expect(originAllowed(undefined, 4000)).toBe(true);
    expect(originAllowed('http://127.0.0.1:4000', 4000)).toBe(true);
    for (const origin of ['null', 'https://127.0.0.1:4000', 'http://evil.example']) {
      expect(originAllowed(origin, 4000)).toBe(false);
    }
  });

  it('requires a same-origin signal for state changes', () => {
    const own = 'http://127.0.0.1:4000';
    expect(stateChangeAllowed(own, 'same-origin', 4000)).toBe(true);
    expect(stateChangeAllowed(own, undefined, 4000)).toBe(true);
    expect(stateChangeAllowed(undefined, 'same-origin', 4000)).toBe(false);
    expect(stateChangeAllowed('null', undefined, 4000)).toBe(false);
    expect(stateChangeAllowed(own, 'cross-site', 4000)).toBe(false);
  });

  it('compares tokens and reads cookies', () => {
    expect(tokenMatches('abc', 'abc')).toBe(true);
    expect(tokenMatches('abc', 'abd')).toBe(false);
    expect(tokenMatches('abc', undefined)).toBe(false);
    expect(tokenMatches('abc', '')).toBe(false);
    expect(readCookie('a=1; recap=xyz', 'recap')).toBe('xyz');
    expect(readCookie('xrecap=1', 'recap')).toBeUndefined();
    expect(readCookie(undefined, 'recap')).toBeUndefined();
  });
});

describe('browser client', () => {
  it('filters lines', () => {
    const line = { label: 'ic', attention: false };
    expect(matchesFilter('all', line)).toBe(true);
    expect(matchesFilter('attention', line)).toBe(false);
    expect(matchesFilter('attention', { ...line, attention: true })).toBe(true);
    expect(matchesFilter('label:ic', line)).toBe(true);
    expect(matchesFilter('label:ooc', line)).toBe(false);
  });

  it('moves through lines and stops at the ends', () => {
    expect(moveIndex(-1, 3, 1)).toBe(0);
    expect(moveIndex(-1, 3, -1)).toBe(2);
    expect(moveIndex(2, 3, 1)).toBe(2);
    expect(moveIndex(0, 3, -1)).toBe(0);
    expect(moveIndex(-1, 0, 1)).toBe(-1);
  });

  it('never reloads over unsaved edits or while generating', () => {
    expect(reloadAfterGeneration('succeeded', 0)).toBe(true);
    expect(reloadAfterGeneration('succeeded', 1)).toBe(false);
    expect(reloadAfterGeneration('running', 0)).toBe(false);
    expect(isTypingTarget('textarea')).toBe(true);
    expect(isTypingTarget('ARTICLE')).toBe(false);
  });

  it('bundles for the browser, with no Node built-ins and no HTML sinks', async () => {
    const entry = fileURLToPath(new URL('../../src/review-ui/client/main.ts', import.meta.url));
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
    });
    const code = result.outputFiles[0]?.text ?? '';
    expect(code).toContain('/api/recap/regeneration');
    expect(code).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
  });
});
