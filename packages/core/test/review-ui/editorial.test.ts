/**
 * The T15 routes over real loopback HTTP: editing, approval, export and Copy Markdown behind the
 * T14 checks. Synthetic data, no model calls.
 */
import { validateContract, type Recap } from '@sargas-recap/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '../../src/log/index.ts';
import { startReviewServer, type RunningReviewServer } from '../../src/review-ui/index.ts';
import { CLASS_1, newWorld, result, RUN_A, seg, type World } from '../review/helpers.ts';
import { openBrowser, raw, writeRecap, type Browser } from './helpers.ts';

const SECRET_NOTE = 'SENTINELA-NOTA-GM';
const SECRET_LINE = 'SENTINELA-LINHA-PRIVADA';
const SENTENCE_TEXT = 'Kira abriu a porta do farol.';
const XSS = `<script>alert('x')</script><img src=x onerror=alert(1)>`;

const A0 = seg(RUN_A, 0, 0, 1_000, 'Kira abre a porta.');
const A1 = seg(RUN_A, 0, 1, 5_000, `Linha ${SECRET_LINE}`);

const base = '/api/recap/revisions/1';

let world: World;
let server: RunningReviewServer;
let browser: Browser;
let logged: string[];

function draft(): Pick<Recap, 'sentences' | 'gm_notes'> {
  return {
    sentences: [
      {
        sentence_id: 'r1:s0',
        text: SENTENCE_TEXT,
        assertion: 'completed',
        citations: { segment_ids: [A0.segment_id], event_ids: [] },
      },
    ],
    gm_notes: [
      {
        note_id: 'r1:g0',
        reason: 'unsupported',
        text: SECRET_NOTE,
        citations: { segment_ids: [], event_ids: [] },
      },
    ],
  };
}

beforeEach(async () => {
  world = await newWorld();
  logged = [];
  await world.transcribe(RUN_A, [A0, A1]);
  await world.classify(CLASS_1, RUN_A, [result(CLASS_1, A0, 'ic'), result(CLASS_1, A1, 'ic')]);
  await writeRecap(world, 1, draft());
  server = await startReviewServer({
    ref: world.ref,
    logger: createLogger({ level: 'debug', sink: (line) => logged.push(line) }),
    clientScript: 'export {};',
  });
  browser = await openBrowser(server);
});

afterEach(async () => {
  await server.close();
  world.close();
});

interface EditorialJson {
  state: string;
  content_hash: string;
  edit_count: number;
  can_copy: boolean;
  approval: { reviewer_id: string } | null;
  blockers: { code: string }[];
}

async function state(): Promise<EditorialJson> {
  return JSON.parse((await browser.get(base)).text) as EditorialJson;
}

async function approve(): Promise<string> {
  const { content_hash: hash } = await state();
  expect((await browser.postJson(`${base}/review`, { expected_hash: hash })).status).toBe(200);
  expect((await browser.postJson(`${base}/approve`, { expected_hash: hash })).status).toBe(200);
  return hash;
}

function sendEdit(count: number, text: string) {
  return browser.postJson(`${base}/edits`, {
    target_kind: 'sentence',
    target_id: 'r1:s0',
    action: 'replace',
    text,
    expected_edit_count: count,
  });
}

describe('the routes sit behind the T14 checks', () => {
  const routes = ['edits', 'review', 'approve', 'reopen', 'export'];

  it.each(routes)('POST %s needs the token, the session and our origin', async (step) => {
    const path = `${base}/${step}`;
    const noToken = await browser.postJson(path, {}, { 'X-Recap-Token': 'wrong' });
    expect(noToken.status).toBe(403);
    const foreign = await browser.postJson(path, {}, { Origin: 'http://evil.example' });
    expect(foreign.status).toBe(403);
    const crossSite = await browser.postJson(path, {}, { 'Sec-Fetch-Site': 'cross-site' });
    expect(crossSite.status).toBe(403);
    const noCookie = await browser.postJson(path, {}, { Cookie: '' });
    expect(noCookie.status).toBe(401);
    const badHost = await browser.postJson(path, {}, { Host: 'attacker.test:1' });
    expect(badHost.status).toBe(403);
    expect((await state()).edit_count).toBe(0);
    expect((await state()).state).toBe('draft');
  });

  it('GET reads need the session cookie and refuse a POST-only path', async () => {
    const headers = { Host: `127.0.0.1:${String(server.port)}` };
    expect((await raw(server.port, { path: `${base}/markdown`, headers })).status).toBe(401);
    expect((await browser.get(`${base}/edits`)).status).toBe(405);
  });

  it('refuses an unknown revision and a malformed path', async () => {
    expect((await browser.get('/api/recap/revisions/9')).status).toBe(404);
    expect((await browser.postJson('/api/recap/revisions/abc/review', {})).status).toBe(404);
  });
});

describe('editing and the page', () => {
  it('saves through a browser form, redirects and marks the sentence', async () => {
    const response = await browser.postForm(`${base}/edits`, [
      ['target_kind', 'sentence'],
      ['target_id', 'r1:s0'],
      ['action', 'replace'],
      ['expected_edit_count', '0'],
      ['text', `Texto com ${XSS}`],
      ['citations', '0:0'],
    ]);
    expect(response.status).toBe(303);
    expect(response.headers.location).toBe('/#recap-player');
    const page = (await browser.get('/')).text;
    expect(page).toContain('edited — verify evidence');
    expect(page).not.toContain('<script>alert(');
    expect(page).toContain('&lt;script&gt;alert(');
    expect(page).not.toMatch(/<script(?![^>]*src=)/);
    expect(page).toContain('Texto com');
  });

  it('refuses a stale form', async () => {
    expect((await sendEdit(0, 'Primeira edição.')).status).toBe(200);
    const stale = await sendEdit(0, 'Segunda edição.');
    expect(stale.status).toBe(409);
    expect((JSON.parse(stale.text) as { error: { code: string } }).error.code).toBe('RECAP_STALE');
    expect((await state()).edit_count).toBe(1);
  });

  it('removing via form keeps the sentence out and offers restore', async () => {
    await writeRecap(world, 2, {
      sentences: [
        { ...requiredSentence(), sentence_id: 'r2:s0' },
        { ...requiredSentence(), sentence_id: 'r2:s1', text: 'Outra frase.' },
      ],
      gm_notes: [],
    });
    const response = await browser.postForm('/api/recap/revisions/2/edits', [
      ['target_kind', 'sentence'],
      ['target_id', 'r2:s1'],
      ['action', 'remove'],
      ['expected_edit_count', '0'],
      ['text', 'ignored for a removal'],
      ['citations', ''],
    ]);
    expect(response.status).toBe(303);
    const page = (await browser.get('/')).text;
    expect(page).toContain('Removed sentences');
  });
});

function requiredSentence(): Recap['sentences'][number] {
  return {
    sentence_id: 'r1:s0',
    text: SENTENCE_TEXT,
    assertion: 'completed',
    citations: { segment_ids: [A0.segment_id], event_ids: [] },
  };
}

describe('approve, copy and export over HTTP', () => {
  it('walks draft to exported and serves only approved output', async () => {
    expect((await browser.get(`${base}/markdown`)).status).toBe(409);

    const hash = await approve();
    const approved = await state();
    expect(approved.state).toBe('approved');
    expect(approved.approval?.reviewer_id).toBe('gm');
    expect(approved.can_copy).toBe(true);

    const markdown = await browser.get(`${base}/markdown`);
    expect(markdown.status).toBe(200);
    expect(markdown.headers['content-type']).toContain('text/markdown');
    expect(markdown.text).toContain(SENTENCE_TEXT);
    expect(markdown.text).not.toContain(SECRET_NOTE);

    const page = (await browser.get('/')).text;
    expect(page).toContain('id="copy-source"');
    expect(page).not.toMatch(/<script(?![^>]*src=)/);

    const noBinding = await browser.postJson(`${base}/export`, { expected_hash: 'sha256:x' });
    expect(noBinding.status).toBe(409);

    const exported = await browser.postJson(`${base}/export`, { expected_hash: hash });
    expect(exported.status).toBe(200);
    expect((await state()).state).toBe('exported');

    const file = await browser.get(`${base}/export/latest`);
    expect(file.status).toBe(200);
    expect(file.headers['content-disposition']).toMatch(/attachment; filename="recap-r1-/);
    expect(validateContract('recap-package', JSON.parse(file.text)).ok).toBe(true);
    expect(file.text).not.toContain(SECRET_NOTE);
    expect(file.text).not.toContain(SECRET_LINE);

    const reopen = await browser.postJson(`${base}/reopen`, {});
    expect(reopen.status).toBe(409);
  });

  it('an edit after approval removes the copy text and blocks export', async () => {
    const hash = await approve();
    expect((await sendEdit(0, 'Mudou depois.')).status).toBe(200);
    expect((await state()).state).toBe('draft');
    expect((await browser.get(`${base}/markdown`)).status).toBe(409);
    expect((await browser.get('/')).text).not.toContain('id="copy-source"');
    const refused = await browser.postJson(`${base}/export`, { expected_hash: hash });
    expect(refused.status).toBe(409);
  });

  it('requires a review before approval', async () => {
    const { content_hash: hash } = await state();
    const refused = await browser.postJson(`${base}/approve`, { expected_hash: hash });
    expect(refused.status).toBe(409);
    expect(refused.text).toContain('RECAP_BAD_STATE');
  });

  it('never logs recap or transcript text', async () => {
    await sendEdit(0, 'SENTINELA-TEXTO-EDITADO');
    await approve().catch(() => undefined);
    await browser.get(`${base}/markdown`);
    const all = logged.join('\n');
    expect(all).not.toContain('SENTINELA-TEXTO-EDITADO');
    expect(all).not.toContain(SECRET_NOTE);
    expect(all).not.toContain(SECRET_LINE);
    expect(all).not.toContain(SENTENCE_TEXT);
  });
});
