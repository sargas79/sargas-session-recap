/**
 * Synthetic world and a raw loopback client for the review server tests. `node:http` rather than
 * `fetch`, because these tests must set `Host`, `Origin` and `Cookie` to hostile values.
 */
import { request, type IncomingHttpHeaders } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { FoundryEvent, Recap } from '@sargas-recap/contracts';
import { ulid } from '../../src/ids/ulid.ts';
import { sha256File } from '../../src/package/index.ts';
import type { RunningReviewServer } from '../../src/review-ui/index.ts';
import { CAMPAIGN, CLASS_1, RUN_A, SESSION, type World } from '../review/helpers.ts';

export interface RawResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly text: string;
}

export interface RawRequest {
  readonly method?: string;
  readonly path?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

/** One request to the loopback server, with exactly the headers given. */
export function raw(port: number, options: RawRequest = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'GET',
        path: options.path ?? '/',
        agent: false,
        headers: { ...options.headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8'),
          });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

/** What a legitimate page on this server sends. */
export interface Browser {
  readonly cookie: string;
  get(path?: string, headers?: Readonly<Record<string, string>>): Promise<RawResponse>;
  postJson(
    path: string,
    body: unknown,
    headers?: Readonly<Record<string, string>>,
  ): Promise<RawResponse>;
  postForm(
    path: string,
    fields: readonly (readonly [string, string])[],
    headers?: Readonly<Record<string, string>>,
  ): Promise<RawResponse>;
}

/** Opens the launch URL as the GM's browser would, and keeps the cookie it gets. */
export async function openBrowser(server: RunningReviewServer): Promise<Browser> {
  const launch = await raw(server.port, {
    path: new URL(server.launchUrl).pathname + new URL(server.launchUrl).search,
    headers: { Host: `127.0.0.1:${String(server.port)}` },
  });
  if (launch.status !== 303) throw new Error(`launch failed: ${String(launch.status)}`);
  const cookie = (launch.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? '';
  const base = {
    Host: `127.0.0.1:${String(server.port)}`,
    Cookie: cookie,
  };
  const posting = { ...base, Origin: server.origin, 'Sec-Fetch-Site': 'same-origin' };
  return {
    cookie,
    get: (p = '/', headers = {}) => raw(server.port, { path: p, headers: { ...base, ...headers } }),
    postJson: (p, body, headers = {}) =>
      raw(server.port, {
        method: 'POST',
        path: p,
        body: JSON.stringify(body),
        headers: {
          ...posting,
          'Content-Type': 'application/json',
          'X-Recap-Token': server.token,
          ...headers,
        },
      }),
    postForm: (p, fields, headers = {}) =>
      raw(server.port, {
        method: 'POST',
        path: p,
        body: new URLSearchParams([
          ['_token', server.token],
          ...fields.map(([k, v]): [string, string] => [k, v]),
        ]).toString(),
        headers: {
          ...posting,
          'Content-Type': 'application/x-www-form-urlencoded',
          ...headers,
        },
      }),
  };
}

export function overridePath(segmentId: string): string {
  return `/api/segments/${encodeURIComponent(segmentId)}/override`;
}

/** Records a finished recap revision where the recap stage writes one. */
export async function writeRecap(
  world: World,
  revision: number,
  partial: Pick<Recap, 'sentences' | 'gm_notes'> & { title?: string },
  overridesHash?: string,
): Promise<void> {
  const recap: Recap = {
    schema_version: 1,
    campaign_id: CAMPAIGN,
    session_id: SESSION,
    recap_revision: revision,
    transcription_run_id: RUN_A,
    classification_run_id: CLASS_1,
    language: 'pt-BR',
    generated_at: '2026-11-02T22:00:00.000Z',
    title: partial.title ?? 'Sessão sintética',
    sentences: partial.sentences,
    gm_notes: partial.gm_notes,
  };
  const rel = `recap/${String(revision)}/recap.json`;
  const file = path.join(world.sessionDir, 'recap', String(revision), 'recap.json');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(recap, null, 2));
  const { hash } = await sha256File(file);
  const at = `2026-11-02T22:00:${String(revision).padStart(2, '0')}.000Z`;
  const jobId = ulid();
  world.db
    .prepare(
      `INSERT INTO jobs (job_id, campaign_id, session_id, stage, status, max_attempts,
         output_recap_revision, created_at, started_at, finished_at)
       VALUES (?, ?, ?, 'recap', 'succeeded', 1, ?, ?, ?, ?)`,
    )
    .run(jobId, CAMPAIGN, SESSION, revision, at, at, at);
  world.db
    .prepare('INSERT INTO job_outputs (job_id, path, hash) VALUES (?, ?, ?)')
    .run(jobId, rel, hash);
  if (overridesHash !== undefined) {
    world.db
      .prepare(
        "INSERT INTO job_inputs (job_id, kind, ref, hash) VALUES (?, 'overrides', 'effective-transcript', ?)",
      )
      .run(jobId, overridesHash);
  }
}

export function foundryEvent(seq: number, observedAt: number, type: string): FoundryEvent {
  return {
    schema_version: 1,
    event_id: `fvtt:01JBX7A0B1C2D3E4F5G6H7J8K9:${String(seq)}`,
    capture_id: '01JBX7A0B1C2D3E4F5G6H7J8K9',
    seq,
    campaign_id: CAMPAIGN,
    session_id: SESSION,
    world_id: 'synthetic',
    writer_user_id: 'AbCdEfGh01234567',
    foundry_version: '14.0',
    system_id: 'pf2e',
    system_version: '7.0.0',
    type,
    observed_at_unix_ms: observedAt,
    clock_uncertainty_ms: 50,
    payload: { note: '<script>alert("foundry")</script>' },
  };
}

export function writeFoundry(world: World, lines: readonly string[]): void {
  writeFileSync(path.join(world.sessionDir, 'foundry.jsonl'), lines.join('\n'));
}
