import { connect } from 'node:net';
import path from 'node:path';
import { Command } from 'commander';
import { validateContract } from '@sargas-recap/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defineStages, type StageDefinition } from '../../src/jobs/index.ts';
import { createLogger } from '../../src/log/index.ts';
import { loadPromptRegistry, promptJobInput } from '../../src/prompts/index.ts';
import {
  registerReviewUiCommand,
  startReviewServer,
  type ReviewServerOptions,
  type RunningReviewServer,
} from '../../src/review-ui/index.ts';
import {
  listOverrideHistory,
  listOverrides,
  loadSessionReview,
  setSegmentOverride,
} from '../../src/review/index.ts';
import { glossary } from '../config/helpers.ts';
import { runConfig } from '../jobs/helpers.ts';
import { llmCampaign } from '../llm/helpers.ts';
import {
  CAMPAIGN,
  CLASS_1,
  newWorld,
  result,
  RUN_A,
  RUN_B,
  seg,
  SESSION,
  type World,
} from '../review/helpers.ts';
import {
  foundryEvent,
  openBrowser,
  overridePath,
  raw,
  writeFoundry,
  writeRecap,
  type Browser,
} from './helpers.ts';

const SECRET_TEXT = 'SENTINELA-TEXTO-PRIVADO';
const XSS = `<script>alert('x')</script><img src=x onerror=alert(1)>`;
const ATTR_XSS = `"><img src=x onerror=alert(2)>`;

const A0 = seg(RUN_A, 0, 0, 1_000, `Kira abre a porta ${SECRET_TEXT}`);
const SPOILER = seg(RUN_A, 0, 1, 700_000, 'O guarda é o traidor');
const LOOP = seg(RUN_A, 0, 2, 800_000, 'de novo de novo de novo', {
  flags: ['repetition_loop'],
});
const LOW = seg(RUN_A, 0, 3, 900_000, 'talvez o farol', {
  flags: ['low_confidence'],
  confidence_permille: 210,
});
const SPELL = seg(RUN_A, 0, 4, 1_000_000, 'o draguão voou');
const MIXED = seg(RUN_A, 0, 5, 1_100_000, `linha mista ${XSS}${ATTR_XSS}`);

let world: World;
let logged: string[];
let server: RunningReviewServer;
let browser: Browser;

async function open(options: Partial<ReviewServerOptions> = {}): Promise<void> {
  server = await startReviewServer({
    ref: world.ref,
    logger: createLogger({ level: 'debug', sink: (line) => logged.push(line) }),
    clientScript: 'export {};',
    ...options,
  });
  browser = await openBrowser(server);
}

async function seed(): Promise<void> {
  await world.transcribe(RUN_A, [A0, SPOILER, LOOP, LOW, SPELL, MIXED]);
  await world.classify(CLASS_1, RUN_A, [
    result(CLASS_1, A0, 'ic'),
    result(CLASS_1, SPOILER, 'ic', { flags: ['possible_spoiler'] }),
    result(CLASS_1, LOOP, 'ic'),
    result(CLASS_1, LOW, 'narration'),
    result(CLASS_1, SPELL, 'ic', {
      text_corrected: `o dragão voou ${XSS}`,
      corrections: [{ kind: 'spelling', from: 'draguão', to: `dragão${ATTR_XSS}` }],
    }),
    result(CLASS_1, MIXED, 'mixed'),
  ]);
}

beforeEach(async () => {
  world = await newWorld();
  logged = [];
  await seed();
});

afterEach(async () => {
  await server.close();
  world.close();
});

function attempts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.2', port, timeout: 1_500 });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      resolve(false);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function noOverrideWritten(): void {
  expect(listOverrides(world.db, CAMPAIGN, SESSION)).toEqual([]);
}

describe('binding and access', () => {
  it('listens on 127.0.0.1 only', async () => {
    await open();
    expect(server.origin).toBe(`http://127.0.0.1:${String(server.port)}`);
    expect(await attempts(server.port)).toBe(false);
  });

  it('gives the launch secret once as a strict cookie and drops it from the URL', async () => {
    await open();
    const launch = await raw(server.port, {
      path: `/?key=${server.token}`,
      headers: { Host: `127.0.0.1:${String(server.port)}` },
    });
    expect(launch.status).toBe(303);
    expect(launch.headers.location).toBe('/');
    const cookie = launch.headers['set-cookie']?.[0] ?? '';
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
  });

  it('refuses a request without the session cookie', async () => {
    await open();
    const headers = { Host: `127.0.0.1:${String(server.port)}` };
    expect((await raw(server.port, { headers })).status).toBe(401);
    const page = await raw(server.port, { path: '/?key=wrong', headers });
    expect(page.status).toBe(401);
    const post = await raw(server.port, {
      method: 'POST',
      path: overridePath(A0.segment_id),
      headers: { ...headers, Origin: server.origin, 'Content-Type': 'application/json' },
      body: '{"status":"reviewed"}',
    });
    expect(post.status).toBe(401);
    noOverrideWritten();
  });

  it.each(['evil.example', 'localhost', 'attacker.test:80', '127.0.0.1'])(
    'refuses Host %s, which is how DNS rebinding arrives',
    async (host) => {
      await open();
      const response = await raw(server.port, {
        headers: { Host: host, Cookie: browser.cookie },
      });
      expect(response.status).toBe(403);
      expect(response.text).not.toContain(SECRET_TEXT);
    },
  );

  it.each(['http://evil.example', 'null', 'https://127.0.0.1', 'http://localhost'])(
    'refuses Origin %s on reads and writes, with a valid cookie and token',
    async (origin) => {
      await open();
      const read = await browser.get('/api/review', { Origin: origin });
      expect(read.status).toBe(403);
      expect(read.text).not.toContain(SECRET_TEXT);
      const write = await browser.postJson(
        overridePath(A0.segment_id),
        { status: 'reviewed' },
        { Origin: origin },
      );
      expect(write.status).toBe(403);
      noOverrideWritten();
    },
  );

  it('refuses a POST with no Origin or from a cross-site context', async () => {
    await open();
    const noOrigin = await raw(server.port, {
      method: 'POST',
      path: overridePath(A0.segment_id),
      headers: {
        Host: `127.0.0.1:${String(server.port)}`,
        Cookie: browser.cookie,
        'Content-Type': 'application/json',
        'X-Recap-Token': server.token,
      },
      body: '{"status":"reviewed"}',
    });
    expect(noOrigin.status).toBe(403);
    const crossSite = await browser.postJson(
      overridePath(A0.segment_id),
      { status: 'reviewed' },
      { 'Sec-Fetch-Site': 'cross-site' },
    );
    expect(crossSite.status).toBe(403);
    noOverrideWritten();
  });

  it('refuses a missing or wrong CSRF token, on JSON and on forms', async () => {
    await open();
    expect(
      (
        await browser.postJson(
          overridePath(A0.segment_id),
          { status: 'reviewed' },
          { 'X-Recap-Token': 'wrong' },
        )
      ).status,
    ).toBe(403);
    const noToken = await raw(server.port, {
      method: 'POST',
      path: overridePath(A0.segment_id),
      headers: {
        Host: `127.0.0.1:${String(server.port)}`,
        Cookie: browser.cookie,
        Origin: server.origin,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'status=reviewed',
    });
    expect(noToken.status).toBe(403);
    noOverrideWritten();
  });

  it('refuses content types a cross-site form could send', async () => {
    await open();
    for (const contentType of ['text/plain', 'multipart/form-data; boundary=x']) {
      const response = await browser.postJson(
        overridePath(A0.segment_id),
        { status: 'reviewed' },
        { 'Content-Type': contentType },
      );
      expect(response.status).toBe(415);
    }
    noOverrideWritten();
  });

  it('answers methods and paths it does not know, and sends no CORS headers', async () => {
    await open();
    expect((await browser.get('/nope')).status).toBe(404);
    expect((await browser.get(overridePath(A0.segment_id))).status).toBe(405);
    const preflight = await raw(server.port, {
      method: 'OPTIONS',
      path: overridePath(A0.segment_id),
      headers: {
        Host: `127.0.0.1:${String(server.port)}`,
        Cookie: browser.cookie,
        Origin: server.origin,
      },
    });
    expect(preflight.status).toBe(405);
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('caps the body size', async () => {
    await open();
    const response = await browser.postJson(overridePath(A0.segment_id), {
      text: 'x'.repeat(300 * 1024),
    });
    expect(response.status).toBe(413);
    noOverrideWritten();
  });

  it('sets a strict CSP and no-store on every answer', async () => {
    await open();
    const page = await browser.get();
    const csp = page.headers['content-security-policy'] ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain('unsafe');
    expect(page.headers['x-frame-options']).toBe('DENY');
    expect(page.headers['x-content-type-options']).toBe('nosniff');
    expect(page.headers['cache-control']).toBe('no-store');
    const css = await browser.get('/static/review.css');
    expect(css.headers['content-type']).toContain('text/css');
  });
});

describe('review API', () => {
  it('serves the effective transcript contract', async () => {
    await open();
    const response = await browser.get('/api/review');
    expect(response.status).toBe(200);
    const body = JSON.parse(response.text) as { view: unknown; regeneration: unknown };
    expect(validateContract('effective-transcript-review', body.view).ok).toBe(true);
    expect(body.regeneration).toEqual({ status: 'idle' });
  });

  it('writes the same state the CLI service writes', async () => {
    await open();
    const response = await browser.postJson(overridePath(MIXED.segment_id), {
      label: 'ic',
      inclusion: 'include',
      text: 'linha limpa',
      exclusions: [],
      status: 'reviewed',
    });
    expect(response.status).toBe(200);
    const created = (JSON.parse(response.text) as { override: { override_id: string } }).override;
    expect(validateContract('review-override', created).ok).toBe(true);

    const { view } = await loadSessionReview(world.ref);
    const segment = view.segments.find((s) => s.segment_id === MIXED.segment_id);
    expect(segment).toMatchObject({
      label: 'ic',
      label_source: 'override',
      recap_inclusion: 'include',
      text: 'linha limpa',
      text_source: 'override',
      review_status: 'reviewed',
    });
    expect(listOverrideHistory(world.db, created.override_id).map((e) => e.action)).toEqual([
      'create',
    ]);
  });

  it('clears with null and lets an exclusion win', async () => {
    await open();
    await browser.postJson(overridePath(A0.segment_id), {
      label: 'ooc',
      exclusions: ['spoiler'],
    });
    await browser.postJson(overridePath(A0.segment_id), { label: null });
    const { view } = await loadSessionReview(world.ref);
    expect(view.segments[0]).toMatchObject({
      label: 'ic',
      label_source: 'classification',
      recap_inclusion: 'exclude',
      exclusion_reasons: ['spoiler'],
    });
  });

  it('validates input', async () => {
    await open();
    for (const body of [
      { label: 'nope' },
      { inclusion: 'maybe' },
      { exclusions: ['spoiler', 'x'] },
      { status: 'done' },
      { expected_revision: -1 },
      { surprise: 1 },
      {},
    ]) {
      expect((await browser.postJson(overridePath(A0.segment_id), body)).status).toBe(400);
    }
    expect(
      (await browser.postJson(overridePath(`${RUN_A}:9:9`), { status: 'reviewed' })).status,
    ).toBe(404);
    expect(
      (
        await raw(server.port, {
          method: 'POST',
          path: overridePath(A0.segment_id),
          headers: {
            Host: `127.0.0.1:${String(server.port)}`,
            Cookie: browser.cookie,
            Origin: server.origin,
            'Content-Type': 'application/json',
            'X-Recap-Token': server.token,
          },
          body: '{not json',
        })
      ).status,
    ).toBe(400);
    noOverrideWritten();
  });

  it('refuses a stale form instead of undoing a newer decision', async () => {
    await open();
    await setSegmentOverride(world.ref, A0.segment_id, { labelOverride: 'ooc' });
    const stale = await browser.postJson(overridePath(A0.segment_id), {
      label: 'ic',
      expected_revision: 0,
    });
    expect(stale.status).toBe(409);
    expect(listOverrides(world.db, CAMPAIGN, SESSION)[0]?.label_override).toBe('ooc');
  });

  it('applies browser forms and returns to the line', async () => {
    await open();
    const response = await browser.postForm(overridePath(MIXED.segment_id), [
      ['expected_revision', '0'],
      ['exclusions_present', '1'],
      ['exclusions', 'spoiler'],
      ['exclusions', 'privacy'],
      ['label', ''],
      ['inclusion', 'default'],
      ['status', 'reviewed'],
      ['text', 'texto limpo\r\ncom linha'],
    ]);
    expect(response.status).toBe(303);
    expect(response.headers.location).toBe(`/#seg-${RUN_A}-0-5`);
    const [override] = listOverrides(world.db, CAMPAIGN, SESSION);
    expect(override).toMatchObject({
      exclusion_reasons: ['spoiler', 'privacy'],
      text_override: 'texto limpo\ncom linha',
      review_status: 'reviewed',
    });
    expect(override?.label_override).toBeUndefined();
  });

  it('does not create an empty override from an untouched form', async () => {
    await open();
    const response = await browser.postForm(overridePath(A0.segment_id), [
      ['expected_revision', '0'],
      ['exclusions_present', '1'],
      ['label', ''],
      ['inclusion', 'default'],
      ['status', 'pending'],
      ['text', '  '],
    ]);
    expect(response.status).toBe(303);
    noOverrideWritten();
  });

  it('reconciles and discards through the T12 services', async () => {
    await setSegmentOverride(world.ref, A0.segment_id, { exclusionReasons: ['spoiler'] });
    await setSegmentOverride(world.ref, SPOILER.segment_id, { labelOverride: 'ooc' });
    const B0 = seg(RUN_B, 0, 0, 1_000, A0.text_original);
    const B1 = seg(RUN_B, 0, 1, 5_000, 'outra coisa');
    await world.transcribe(RUN_B, [B0, B1]);
    await open();

    const page = (await browser.get()).text;
    expect(page.indexOf('Needs reconciliation')).toBeGreaterThan(-1);
    expect(page.indexOf('Needs reconciliation')).toBeLessThan(page.indexOf('Review queue'));
    expect(page).toContain('blocks the recap');
    expect(page).toContain('same words');

    const overrides = listOverrides(world.db, CAMPAIGN, SESSION);
    const spoilerOverride = overrides.find((o) => o.segment_id === A0.segment_id);
    const other = overrides.find((o) => o.segment_id === SPOILER.segment_id);
    expect(
      (
        await browser.postJson(`/api/overrides/${spoilerOverride?.override_id ?? ''}/reconcile`, {
          segment_id: B0.segment_id,
        })
      ).status,
    ).toBe(200);
    expect(
      (await browser.postForm(`/api/overrides/${other?.override_id ?? ''}/discard`, [])).status,
    ).toBe(303);
    const { view } = await loadSessionReview(world.ref);
    expect(view.needs_reconciliation).toEqual([]);
    expect(view.segments[0]?.exclusion_reasons).toEqual(['spoiler']);
    expect(
      (await browser.postJson(`/api/overrides/${other?.override_id ?? ''}/discard`, {})).status,
    ).toBe(409);
  });
});

describe('review screen', () => {
  it('escapes every piece of session text in text and attributes', async () => {
    const injected = `${XSS}${ATTR_XSS}`;
    await setSegmentOverride(world.ref, MIXED.segment_id, { textOverride: injected });
    await writeRecap(world, 1, {
      title: injected,
      sentences: [
        {
          sentence_id: 'r1:s0',
          text: injected,
          assertion: 'completed',
          citations: { segment_ids: [MIXED.segment_id], event_ids: [] },
        },
      ],
      gm_notes: [
        {
          note_id: 'r1:g0',
          reason: 'unsupported',
          text: injected,
          citations: { segment_ids: [], event_ids: [] },
        },
      ],
    });
    writeFoundry(world, [JSON.stringify(foundryEvent(1, 1_000, 'core.roll'))]);
    await open();
    const { text: page, status } = await browser.get();
    expect(status).toBe(200);
    expect(page).toContain('&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;');
    expect(page).not.toContain("<script>alert('x')");
    expect(page).not.toContain('<script>alert(&quot;foundry');
    expect(page).not.toContain('<img src=x');
    // The attribute form: quoted, with the quote escaped so it cannot end the attribute.
    expect(page).toMatch(/title="[^"]*&quot;&gt;&lt;img src=x onerror=alert\(2\)&gt;/);
    // Only the external module script; no inline script, handler or style.
    expect(page.match(/<script/g)).toEqual(['<script']);
    expect(page).toContain('<script type="module" src="/static/review.js"></script>');
    // Session text has its quotes escaped, so every quoted string left is a real attribute value.
    const tags = page.replace(/"[^"]*"/g, '""');
    expect(tags).not.toMatch(/<[a-z][^>]*\son[a-z]+\s*=/i);
    expect(tags).not.toMatch(/<[a-z][^>]*\sstyle\s*=/i);
    expect(page).not.toContain('<style');
    expect(page).not.toContain('javascript:');
  });

  it('shows the queue first and flags what the GM must see', async () => {
    await open();
    const page = (await browser.get()).text;
    expect(page.indexOf('id="queue"')).toBeLessThan(page.indexOf('id="transcript"'));
    expect(page).toContain('POSSIBLE SPOILER');
    expect(page).toContain('This line is INCLUDED in the recap');
    expect(page).toContain('generation does not filter it out');
    expect(page).toContain('possible spoiler');
    expect(page).toContain('repetition loop');
    expect(page).toContain('low ASR confidence');
    expect(page).toContain('spelling correction');
    expect(page).toContain('no glossary entry');
    expect(page).toContain('o draguão voou');
    expect(page).toContain('o dragão voou');
    expect(page).toContain('Original (ASR)');
    expect(page).toContain('tr class="spelling"');
    // The spoiler outranks the others in the queue, whatever its timing.
    const queue = page.slice(page.indexOf('id="queue"'), page.indexOf('id="transcript"'));
    expect(queue.indexOf('possible spoiler')).toBeLessThan(queue.indexOf('unresolved'));
    expect(queue.indexOf('unresolved')).toBeLessThan(queue.indexOf('spelling correction'));
    // Chronological order in the list, and a coloured label class on each line.
    const body = page.slice(page.indexOf('id="transcript"'));
    expect(body.indexOf(`seg-${RUN_A}-0-0`)).toBeLessThan(body.indexOf(`seg-${RUN_A}-0-5`));
    expect(page).toContain('label-mixed');
    expect(page).toContain('Jump to time');
  });

  it('drops a reviewed line from the queue but keeps it, with its flag, in the list', async () => {
    await setSegmentOverride(world.ref, SPOILER.segment_id, {
      exclusionReasons: ['spoiler'],
      reviewStatus: 'reviewed',
    });
    await open();
    const page = (await browser.get()).text;
    const queue = page.slice(page.indexOf('id="queue"'), page.indexOf('id="transcript"'));
    expect(queue).not.toContain('O guarda é o traidor');
    expect(page).toContain('O guarda é o traidor');
    expect(page).toContain('POSSIBLE SPOILER');
    expect(page).toContain('Recap inclusion: exclude');
  });

  it('keeps GM notes apart from the player-facing text and links footnotes to lines', async () => {
    await writeRecap(world, 1, {
      sentences: [
        {
          sentence_id: 'r1:s0',
          text: 'FRASE-PARA-JOGADORES',
          assertion: 'completed',
          citations: { segment_ids: [A0.segment_id], event_ids: [] },
        },
        {
          sentence_id: 'r1:s1',
          text: 'Cita um spoiler',
          assertion: 'completed',
          citations: { segment_ids: [SPOILER.segment_id], event_ids: [] },
        },
      ],
      gm_notes: [
        {
          note_id: 'r1:g0',
          reason: 'unresolved',
          text: 'NOTA-SO-DO-MESTRE',
          citations: { segment_ids: [], event_ids: [] },
        },
      ],
    });
    await open();
    const page = (await browser.get()).text;
    const player = page.slice(
      page.indexOf('id="recap-player"'),
      page.indexOf('id="recap-gm-notes"'),
    );
    const notes = page.slice(page.indexOf('id="recap-gm-notes"'));
    expect(player).toContain('FRASE-PARA-JOGADORES');
    expect(player).not.toContain('NOTA-SO-DO-MESTRE');
    expect(notes).toContain('NOTA-SO-DO-MESTRE');
    expect(notes).toContain('NEVER SEND TO PLAYERS');
    const anchor = `seg-${RUN_A}-0-0`;
    expect(player).toContain(`href="#${anchor}"`);
    expect(page).toContain(`id="${anchor}"`);
    expect(page).toContain('href="#sent-r1-s0"');
    expect(player).toContain('cites a possible spoiler');
  });

  it('offers no publish action, and no approval or export on an unreviewed draft', async () => {
    await writeRecap(world, 1, {
      sentences: [
        {
          sentence_id: 'r1:s0',
          text: 'Frase',
          assertion: 'completed',
          citations: { segment_ids: [A0.segment_id], event_ids: [] },
        },
      ],
      gm_notes: [],
    });
    await open();
    const page = (await browser.get()).text;
    const forms = [...page.matchAll(/action="([^"]+)"/g)].map((m) => m[1] ?? '');
    for (const action of forms) {
      expect(action).toMatch(
        /^\/api\/(segments|overrides)\/[^/]+\/\w+$|^\/api\/recap\/regenerate$|^\/api\/recap\/revisions\/\d+\/(edits|review|approve|reopen|export)$/,
      );
    }
    expect(page).not.toMatch(/<button[^>]*>\s*(Publish|Approve|Export)/i);
  });

  it('warns when the draft no longer matches the corrections', async () => {
    await writeRecap(
      world,
      1,
      {
        sentences: [
          {
            sentence_id: 'r1:s0',
            text: 'Frase',
            assertion: 'completed',
            citations: { segment_ids: [A0.segment_id], event_ids: [] },
          },
        ],
        gm_notes: [],
      },
      'sha256:' + '0'.repeat(64),
    );
    await open();
    expect((await browser.get()).text).toContain('You changed lines since this draft was written');
  });

  it('shows a broken draft as a problem and still serves the transcript', async () => {
    await writeRecap(world, 1, {
      sentences: [
        {
          sentence_id: 'r1:s0',
          text: 'Frase',
          assertion: 'completed',
          citations: { segment_ids: [A0.segment_id], event_ids: [] },
        },
      ],
      gm_notes: [],
    });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path.join(world.sessionDir, 'recap', '1', 'recap.json'), '{}');
    await open();
    const page = await browser.get();
    expect(page.status).toBe(200);
    expect(page.text).toContain('cannot be shown');
    expect(page.text).toContain(SECRET_TEXT);
  });

  it('places Foundry events inline with an estimate, and lists the rest apart', async () => {
    writeFoundry(world, [
      JSON.stringify(foundryEvent(1, 750_000 + Date.UTC(2026, 10, 2), 'core.roll')),
      'not json',
    ]);
    const { baseManifest } = await import('../package/helpers.ts');
    const { writeFileSync } = await import('node:fs');
    const manifest = baseManifest();
    manifest.campaign_id = CAMPAIGN;
    manifest.session_id = SESSION;
    manifest.timeline.origin_wall_clock_unix_ms = Date.UTC(2026, 10, 2);
    writeFileSync(path.join(world.sessionDir, 'manifest.json'), JSON.stringify(manifest));
    await open();
    const page = (await browser.get()).text;
    const body = page.slice(page.indexOf('id="transcript"'));
    const event = body.indexOf('core.roll');
    expect(event).toBeGreaterThan(body.indexOf(`seg-${RUN_A}-0-1`));
    expect(event).toBeLessThan(body.indexOf(`seg-${RUN_A}-0-2`));
    expect(page).toContain('estimates from the capture clocks');
    expect(page).toContain('1 unreadable line(s) skipped');
  });

  it('lists events apart when the package has no clock origin', async () => {
    writeFoundry(world, [JSON.stringify(foundryEvent(1, 1_000, 'core.scene'))]);
    await open();
    const page = (await browser.get()).text;
    expect(page.indexOf('Foundry events without a position')).toBeGreaterThan(-1);
    expect(page.indexOf('core.scene')).toBeGreaterThan(
      page.indexOf('Foundry events without a position'),
    );
  });

  it('works without the client bundle', async () => {
    server = await startReviewServer({
      ref: world.ref,
      logger: createLogger({ sink: (line) => logged.push(line) }),
      clientScript: undefined,
    });
    browser = await openBrowser(server);
    const page = await browser.get();
    expect(page.status).toBe(200);
    expect(page.text).toContain('id="filters" hidden');
    expect(page.text).toContain(SECRET_TEXT);
  });
});

describe('logs', () => {
  it('carry no session text, override text or secret through every action', async () => {
    await writeRecap(world, 1, {
      sentences: [
        {
          sentence_id: 'r1:s0',
          text: 'RECAP-SENTINELA',
          assertion: 'completed',
          citations: { segment_ids: [A0.segment_id], event_ids: [] },
        },
      ],
      gm_notes: [],
    });
    await open();
    await browser.get();
    await browser.postJson(overridePath(A0.segment_id), { text: 'OVERRIDE-SENTINELA' });
    await browser.postJson(overridePath(A0.segment_id), { label: 'nope' });
    await browser.postJson(`/api/overrides/${RUN_A}/reconcile`, { segment_id: 'x' });
    await browser.get('/api/review');
    await browser.get('/does/not/exist/SEGMENT-SENTINELA');
    await server.close();
    const joined = logged.join('\n');
    expect(joined).toContain('review-ui.request');
    for (const secret of [
      SECRET_TEXT,
      'OVERRIDE-SENTINELA',
      'RECAP-SENTINELA',
      'SEGMENT-SENTINELA',
      server.token,
      A0.segment_id,
    ]) {
      expect(joined).not.toContain(secret);
    }
    for (const line of logged) expect(JSON.parse(line)).not.toHaveProperty('url');
  });
});

describe('regeneration', () => {
  const config = () => Promise.resolve(runConfig(llmCampaign(), glossary()));
  const generationState = async (): Promise<unknown> =>
    JSON.parse((await browser.get('/api/recap/regeneration')).text) as unknown;
  // The runner refuses a recap stage that records no prompt.
  const promptInput = () => [promptJobInput(loadPromptRegistry().latest('recap.draft'))];

  /** A recap stage the test holds open, without any provider. */
  function heldStage(): { stage: StageDefinition; release: () => void; ran: () => number } {
    let finish: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let runs = 0;
    return {
      stage: {
        name: 'recap',
        inputs: promptInput,
        run: async (ctx) => {
          runs += 1;
          await Promise.race([
            gate,
            new Promise<void>((resolve) => {
              ctx.signal.addEventListener('abort', () => {
                resolve();
              });
            }),
          ]);
          return { outputRecapRevision: 1 };
        },
      },
      release: () => {
        finish();
      },
      ran: () => runs,
    };
  }

  it('is refused without config, and without confirmation', async () => {
    await open();
    expect((await browser.postJson('/api/recap/regenerate', { confirm: 'yes' })).status).toBe(409);
    await server.close();
    await open({ stages: defineStages([heldStage().stage]), loadConfig: config });
    expect((await browser.postJson('/api/recap/regenerate', {})).status).toBe(400);
    expect((await browser.postForm('/api/recap/regenerate', [])).status).toBe(400);
  });

  it('is refused while a spoiler exclusion is unreconciled', async () => {
    await setSegmentOverride(world.ref, A0.segment_id, { exclusionReasons: ['spoiler'] });
    await world.transcribe(RUN_B, [seg(RUN_B, 0, 0, 1_000, 'outra')]);
    const held = heldStage();
    await open({ stages: defineStages([held.stage]), loadConfig: config });
    const response = await browser.postJson('/api/recap/regenerate', { confirm: 'yes' });
    expect(response.status).toBe(409);
    expect(response.text).toContain('REVIEW_UI_UNRECONCILED');
    expect(held.ran()).toBe(0);
    expect((await browser.get()).text).toContain('must be reconciled first');
  });

  it('runs in the background, locks corrections, and finishes', async () => {
    const held = heldStage();
    await open({ stages: defineStages([held.stage]), loadConfig: config });
    const started = await browser.postJson('/api/recap/regenerate', { confirm: 'yes' });
    expect(started.status).toBe(202);
    expect(JSON.parse(started.text)).toEqual({ status: 'running' });

    const locked = await browser.postJson(overridePath(A0.segment_id), { status: 'reviewed' });
    expect(locked.status).toBe(409);
    noOverrideWritten();
    expect((await browser.postJson('/api/recap/regenerate', { confirm: 'yes' })).status).toBe(409);

    const page = (await browser.get()).text;
    expect(page).toContain('data-state="running"');
    expect(page).not.toContain('name="confirm"');

    held.release();
    await expect.poll(generationState).toMatchObject({ status: 'succeeded' });
    expect(
      (await browser.postJson(overridePath(A0.segment_id), { status: 'reviewed' })).status,
    ).toBe(200);
  });

  it('cancels a running generation on close', async () => {
    const held = heldStage();
    await open({ stages: defineStages([held.stage]), loadConfig: config });
    await browser.postJson('/api/recap/regenerate', { confirm: 'yes' });
    await expect.poll(() => held.ran()).toBe(1);
    await server.close();
    expect(held.ran()).toBe(1);
  });

  it('reports a failure without leaking anything but its message', async () => {
    const failing: StageDefinition = {
      name: 'recap',
      inputs: promptInput,
      run: () => {
        throw new Error('boom');
      },
    };
    await open({
      stages: defineStages([failing]),
      loadConfig: () => Promise.reject(new Error('private detail')),
    });
    await browser.postJson('/api/recap/regenerate', { confirm: 'yes' });
    await expect.poll(generationState).toMatchObject({ status: 'failed', errorCode: 'unexpected' });
    const page = (await browser.get()).text;
    expect(page).toContain('Generation failed');
    expect(page).not.toContain('private detail');
  });
});

describe('recap review command', () => {
  async function runCommand(
    args: readonly string[],
    during: (url: string) => Promise<void>,
  ): Promise<{ out: string; err: string; code: typeof process.exitCode }> {
    let out = '';
    let err = '';
    const io = { out: (t: string) => (out += t), err: (t: string) => (err += t) };
    const program = new Command().name('recap').exitOverride();
    program.configureOutput({ writeOut: io.out, writeErr: io.err });
    registerReviewUiCommand(program, io, {
      logger: createLogger({ sink: (line) => logged.push(line) }),
      waitForStop: during,
    });
    process.exitCode = undefined;
    await program.parseAsync(['node', 'recap', ...args]);
    const code = process.exitCode;
    process.exitCode = undefined;
    return { out, err, code };
  }

  const target = () => [
    'review',
    '--campaign',
    CAMPAIGN,
    '--session',
    SESSION,
    '--data-root',
    path.join(world.dir, 'data'),
  ];

  beforeEach(async () => {
    // Every test here starts the server through the command instead.
    await open();
  });

  it('prints a launch URL, serves the screen and stops', async () => {
    let served = 0;
    const result = await runCommand(target(), async (url) => {
      const parsed = new URL(url);
      expect(parsed.hostname).toBe('127.0.0.1');
      const launch = await raw(Number(parsed.port), {
        path: parsed.pathname + parsed.search,
        headers: { Host: parsed.host },
      });
      const cookie = (launch.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? '';
      const page = await raw(Number(parsed.port), {
        headers: { Host: parsed.host, Cookie: cookie },
      });
      served = page.status;
      expect(page.text).toContain(SECRET_TEXT);
    });
    expect(served).toBe(200);
    // "--port 0" and the logger have run; only the terminal saw the launch URL.
    expect(result.code).toBeUndefined();
    expect(result.out).toContain('http://127.0.0.1:');
    expect(logged.join('\n')).not.toContain('key=');
  });

  it('checks its options', async () => {
    const never = () => Promise.reject(new Error('should not start'));
    expect((await runCommand([...target(), '--port', 'x'], never)).code).toBe(2);
    const halfConfig = await runCommand([...target(), '--config', 'a.yaml'], never);
    expect(halfConfig.code).toBe(1);
    expect(halfConfig.err).toContain('go together');
  });
});
