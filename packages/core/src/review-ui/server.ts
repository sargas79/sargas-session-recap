/**
 * The localhost review server (T14): node:http, bound to 127.0.0.1 only. Every request passes the
 * checks in security.ts, and every action calls the services the CLI uses (actions.ts).
 *
 * Logs carry the method, the route pattern, the status and a duration, never a URL (the launch URL
 * holds the secret, and paths hold IDs), a body or an error message.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { RunConfig, StageRegistry } from '../jobs/stage.ts';
import { createLogger, type Logger } from '../log/index.ts';
import {
  applyRecapEdit,
  approvedRecapMarkdown,
  approveRecap,
  exportRecap,
  latestExportFile,
  loadEditorialView,
  markRecapReviewed,
  reopenRecap,
} from '../recap/editorial.ts';
import { toReviewOverride } from '../review/store.ts';
import { loadSessionReview, type SessionRef } from '../review/session.ts';
import {
  applyDiscard,
  applyOverride,
  applyReconcile,
  assertNoFields,
  assertNoLostExclusions,
  assertRegenerationConfirmed,
  editBodyFromForm,
  overrideBodyFromForm,
  parseEditRequest,
  parseExpectedHash,
  parseOverrideRequest,
  parseReconcileTarget,
  parseReleaseRequest,
  parseRevision,
  releaseBodyFromForm,
} from './actions.ts';
import { loadReviewScreen } from './data.ts';
import { refusalOf, ReviewUiError } from './errors.ts';
import { renderMessagePage, renderReviewPage } from './page.ts';
import { createRegenerator, type Regenerator } from './regenerate.ts';
import {
  BIND_HOST,
  cookieName,
  hostAllowed,
  LAUNCH_PARAM,
  MAX_BODY_BYTES,
  newToken,
  originAllowed,
  originOf,
  readCookie,
  SECURITY_HEADERS,
  sessionCookie,
  stateChangeAllowed,
  TOKEN_FIELD,
  TOKEN_HEADER,
  tokenMatches,
} from './security.ts';
import { REVIEW_CSS } from './styles.ts';

export interface ReviewServerOptions {
  readonly ref: SessionRef;
  /** 0 picks a free port. */
  readonly port?: number | undefined;
  /** The stages of `recap run`. With `loadConfig`, enables regeneration. */
  readonly stages?: StageRegistry | undefined;
  readonly loadConfig?: (() => Promise<RunConfig>) | undefined;
  readonly logger?: Logger | undefined;
  /** Operator slug recorded on edits, approvals and exports (ADR-010). Defaults to `gm`. */
  readonly reviewer?: string | undefined;
  /** The built client script. Defaults to the bundle beside this file, when there is one. */
  readonly clientScript?: string | undefined;
}

export interface RunningReviewServer {
  readonly port: number;
  readonly origin: string;
  /** Opens the session in a browser. Contains the secret: for the GM's terminal only. */
  readonly launchUrl: string;
  readonly token: string;
  close(): Promise<void>;
}

/** Fields the server logs. Identifiers of routes and statuses only. */
const LOG_FIELDS = ['method', 'route', 'httpStatus', 'port', 'recapRevision'];

const CLIENT_BUNDLE = new URL('./client.bundle.js', import.meta.url);

function bundledClient(): string | undefined {
  const file = fileURLToPath(CLIENT_BUNDLE);
  return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
}

interface Request {
  readonly match: RegExpExecArray;
  readonly body: unknown;
}

interface Answer {
  readonly status: number;
  /** A browser form goes back to the page, to this anchor. */
  readonly anchor: string;
  readonly payload: unknown;
}

type Action = (request: Request) => Promise<Answer>;

interface PostRoute {
  readonly name: string;
  readonly pattern: RegExp;
  /** Converts a browser form into the JSON body of the API. */
  readonly fromForm: (form: URLSearchParams) => unknown;
  readonly action: Action;
}

function formFields(form: URLSearchParams): Record<string, string> {
  return Object.fromEntries(form.entries());
}

function decodeId(value: string | undefined): string {
  try {
    return decodeURIComponent(value ?? '');
  } catch {
    throw new ReviewUiError(400, 'REVIEW_UI_BAD_REQUEST', 'the path is not valid');
  }
}

function send(
  res: ServerResponse,
  status: number,
  contentType: string,
  body: string,
  extra: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    ...extra,
  });
  res.end(body);
}

const HTML = 'text/html; charset=utf-8';
const JSON_TYPE = 'application/json; charset=utf-8';

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  send(res, status, JSON_TYPE, JSON.stringify(value));
}

function sendRefusal(res: ServerResponse, refusal: ReviewUiError, json: boolean): void {
  if (json) {
    sendJson(res, refusal.status, {
      error: { code: refusal.code, message: refusal.message, hint: refusal.hint },
    });
  } else {
    send(res, refusal.status, HTML, renderMessagePage('Not done', refusal.message, refusal.hint));
  }
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const declared = Number(header(req, 'content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) {
    throw new ReviewUiError(413, 'REVIEW_UI_TOO_LARGE', 'the request is too large');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new ReviewUiError(413, 'REVIEW_UI_TOO_LARGE', 'the request is too large');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function contentKind(req: IncomingMessage): 'json' | 'form' {
  const type = (header(req, 'content-type') ?? '').split(';')[0]?.trim().toLowerCase();
  if (type === 'application/json') return 'json';
  if (type === 'application/x-www-form-urlencoded') return 'form';
  throw new ReviewUiError(415, 'REVIEW_UI_UNSUPPORTED', 'unsupported content type');
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ReviewUiError(400, 'REVIEW_UI_BAD_REQUEST', 'the body is not valid JSON');
  }
}

export async function startReviewServer(
  options: ReviewServerOptions,
): Promise<RunningReviewServer> {
  const { ref } = options;
  const logger = (options.logger ?? createLogger()).child(LOG_FIELDS);
  const token = newToken();
  const clientScript = options.clientScript ?? bundledClient();
  const reviewer = options.reviewer ?? 'gm';
  const regenerator: Regenerator = createRegenerator({
    ref,
    stages: options.stages,
    loadConfig: options.loadConfig,
    logger,
  });
  let port = 0;

  const refuseWhileGenerating = (): void => {
    if (regenerator.state().status === 'running') {
      throw new ReviewUiError(
        409,
        'REVIEW_UI_BUSY',
        'a recap generation is running; corrections are locked until it ends',
      );
    }
  };

  const postRoutes: readonly PostRoute[] = [
    {
      name: '/api/segments/:id/override',
      pattern: /^\/api\/segments\/([^/]+)\/override$/,
      fromForm: overrideBodyFromForm,
      action: async ({ match, body }) => {
        refuseWhileGenerating();
        const segmentId = decodeId(match[1]);
        const override = await applyOverride(ref, segmentId, parseOverrideRequest(body));
        logger.info('review-ui.override-set', { route: 'override', count: 1 });
        return {
          status: 200,
          anchor: `seg-${segmentId.replace(/[^A-Za-z0-9_-]/g, '-')}`,
          payload: { override: override === null ? null : toReviewOverride(override) },
        };
      },
    },
    {
      name: '/api/overrides/:id/reconcile',
      pattern: /^\/api\/overrides\/([^/]+)\/reconcile$/,
      fromForm: formFields,
      action: async ({ match, body }) => {
        refuseWhileGenerating();
        const created = await applyReconcile(ref, decodeId(match[1]), parseReconcileTarget(body));
        logger.info('review-ui.override-reconciled', { route: 'reconcile', count: 1 });
        return {
          status: 200,
          anchor: 'reconciliation',
          payload: { override: toReviewOverride(created) },
        };
      },
    },
    {
      name: '/api/overrides/:id/discard',
      pattern: /^\/api\/overrides\/([^/]+)\/discard$/,
      fromForm: formFields,
      action: async ({ match, body }) => {
        refuseWhileGenerating();
        assertNoFields(body);
        await applyDiscard(ref, decodeId(match[1]));
        logger.info('review-ui.override-discarded', { route: 'discard', count: 1 });
        return { status: 200, anchor: 'reconciliation', payload: { discarded: true } };
      },
    },
    {
      name: '/api/recap/regenerate',
      pattern: /^\/api\/recap\/regenerate$/,
      fromForm: formFields,
      action: async ({ body }) => {
        assertRegenerationConfirmed(body);
        await assertNoLostExclusions(ref);
        regenerator.start();
        return { status: 202, anchor: 'recap', payload: regenerator.state() };
      },
    },
    {
      name: '/api/recap/revisions/:n/edits',
      pattern: /^\/api\/recap\/revisions\/(\d{1,15})\/edits$/,
      fromForm: editBodyFromForm,
      action: async ({ match, body }) => {
        refuseWhileGenerating();
        const revision = parseRevision(match[1]);
        const outcome = await applyRecapEdit(ref, revision, parseEditRequest(body), reviewer);
        logger.info('review-ui.recap-edited', { route: 'edits', recapRevision: outcome.revision });
        return { status: 200, anchor: 'recap-player', payload: outcome };
      },
    },
    {
      name: '/api/recap/revisions/:n/review',
      pattern: /^\/api\/recap\/revisions\/(\d{1,15})\/review$/,
      fromForm: formFields,
      action: async ({ match, body }) => {
        refuseWhileGenerating();
        const revision = parseRevision(match[1]);
        const state = await markRecapReviewed(ref, revision, parseExpectedHash(body), reviewer);
        logger.info('review-ui.recap-reviewed', { route: 'review', recapRevision: revision });
        return { status: 200, anchor: 'recap-approval', payload: { state } };
      },
    },
    {
      name: '/api/recap/revisions/:n/approve',
      pattern: /^\/api\/recap\/revisions\/(\d{1,15})\/approve$/,
      fromForm: releaseBodyFromForm,
      action: async ({ match, body }) => {
        refuseWhileGenerating();
        const revision = parseRevision(match[1]);
        const approval = await approveRecap(ref, revision, parseReleaseRequest(body), reviewer);
        logger.info('review-ui.recap-approved', { route: 'approve', recapRevision: revision });
        return { status: 200, anchor: 'recap-approval', payload: { approval } };
      },
    },
    {
      name: '/api/recap/revisions/:n/reopen',
      pattern: /^\/api\/recap\/revisions\/(\d{1,15})\/reopen$/,
      fromForm: formFields,
      action: async ({ match, body }) => {
        refuseWhileGenerating();
        assertNoFields(body);
        const revision = parseRevision(match[1]);
        const state = await reopenRecap(ref, revision, reviewer);
        logger.info('review-ui.recap-reopened', { route: 'reopen', recapRevision: revision });
        return { status: 200, anchor: 'recap-approval', payload: { state } };
      },
    },
    {
      name: '/api/recap/revisions/:n/export',
      pattern: /^\/api\/recap\/revisions\/(\d{1,15})\/export$/,
      fromForm: releaseBodyFromForm,
      action: async ({ match, body }) => {
        refuseWhileGenerating();
        const revision = parseRevision(match[1]);
        const outcome = await exportRecap(ref, revision, parseReleaseRequest(body), reviewer);
        logger.info('review-ui.recap-exported', { route: 'export', recapRevision: revision });
        return { status: 200, anchor: 'recap-approval', payload: outcome };
      },
    },
  ];

  /** One action at a time: the guards of an action must not interleave with another's writes. */
  let queue: Promise<unknown> = Promise.resolve();
  const serialized = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.then(work, work);
    queue = result.catch(() => undefined);
    return result;
  };

  const handlePost = async (
    req: IncomingMessage,
    res: ServerResponse,
    route: PostRoute,
    match: RegExpExecArray,
  ): Promise<void> => {
    const kind = contentKind(req);
    const text = await readBody(req);
    let body: unknown;
    if (kind === 'json') {
      if (!tokenMatches(token, header(req, TOKEN_HEADER))) throw badToken();
      body = parseJson(text);
    } else {
      const form = new URLSearchParams(text);
      if (!tokenMatches(token, form.get(TOKEN_FIELD) ?? undefined)) throw badToken();
      form.delete(TOKEN_FIELD);
      body = route.fromForm(form);
    }
    const answer = await serialized(() => route.action({ match, body }));
    if (kind === 'json') {
      sendJson(res, answer.status, answer.payload);
    } else {
      send(res, 303, 'text/plain; charset=utf-8', '', { Location: `/#${answer.anchor}` });
    }
  };

  /** The per-revision reads. Returns the route name, or `undefined` when `path` is not one. */
  const handleRevisionGet = async (
    res: ServerResponse,
    path: string,
  ): Promise<string | undefined> => {
    const match = /^\/api\/recap\/revisions\/(\d{1,15})(\/markdown|\/export\/latest)?$/.exec(path);
    if (match === null) return undefined;
    const revision = parseRevision(match[1]);
    switch (match[2]) {
      case '/markdown':
        send(res, 200, 'text/markdown; charset=utf-8', await approvedRecapMarkdown(ref, revision));
        return '/api/recap/revisions/:n/markdown';
      case '/export/latest': {
        const file = await latestExportFile(ref, revision);
        send(res, 200, JSON_TYPE, file.text, {
          'Content-Disposition': `attachment; filename="${file.name}"`,
        });
        return '/api/recap/revisions/:n/export/latest';
      }
      default: {
        const { view } = await loadSessionReview(ref);
        const editorial = await loadEditorialView(ref, revision, view);
        sendJson(res, 200, {
          revision: editorial.revision,
          origin: editorial.origin,
          parent_revision: editorial.parentRevision ?? null,
          state: editorial.state,
          content_hash: editorial.contentHash,
          edit_count: editorial.editCount,
          approval: editorial.approval,
          exports: editorial.exports,
          blockers: editorial.blockers,
          possible_spoilers_included: editorial.spoilersIncluded,
          can_copy: editorial.markdown !== null,
        });
        return '/api/recap/revisions/:n';
      }
    }
  };

  const handleGet = async (res: ServerResponse, path: string): Promise<string> => {
    const revisionRoute = await handleRevisionGet(res, path);
    if (revisionRoute !== undefined) return revisionRoute;
    switch (path) {
      case '/': {
        const screen = await loadReviewScreen(ref);
        send(
          res,
          200,
          HTML,
          renderReviewPage({
            screen,
            token,
            regeneration: regenerator.state(),
            canRegenerate: regenerator.available(),
            hasClient: clientScript !== undefined,
          }),
        );
        return '/';
      }
      case '/api/review': {
        const screen = await loadReviewScreen(ref);
        sendJson(res, 200, {
          view: screen.view,
          overrides: screen.overrides.map(toReviewOverride),
          recap: screen.recap,
          recap_problem: screen.recapProblem,
          foundry_events: screen.foundry.events.length,
          regeneration: regenerator.state(),
        });
        return '/api/review';
      }
      case '/api/recap/regeneration':
        sendJson(res, 200, regenerator.state());
        return '/api/recap/regeneration';
      case '/static/review.css':
        send(res, 200, 'text/css; charset=utf-8', REVIEW_CSS);
        return '/static/review.css';
      case '/static/review.js':
        if (clientScript === undefined) {
          send(res, 404, 'text/plain; charset=utf-8', 'not built');
        } else {
          send(res, 200, 'text/javascript; charset=utf-8', clientScript);
        }
        return '/static/review.js';
      default:
        throw new ReviewUiError(404, 'REVIEW_UI_NOT_FOUND', 'no such page');
    }
  };

  function badToken(): ReviewUiError {
    return new ReviewUiError(403, 'REVIEW_UI_BAD_TOKEN', 'the request token is missing or wrong');
  }

  /** Sets a route name for the log and answers. Throws a refusal to be rendered by the caller. */
  const handle = async (
    req: IncomingMessage,
    res: ServerResponse,
    named: (route: string) => void,
  ): Promise<void> => {
    if (!hostAllowed(header(req, 'host'), port)) {
      throw new ReviewUiError(403, 'REVIEW_UI_BAD_HOST', 'this server only answers on 127.0.0.1');
    }
    const url = new URL(req.url ?? '/', originOf(port));
    const method = req.method ?? 'GET';
    if (!originAllowed(header(req, 'origin'), port)) {
      throw new ReviewUiError(403, 'REVIEW_UI_BAD_ORIGIN', 'cross-origin requests are refused');
    }
    if (method === 'GET' && url.pathname === '/' && url.searchParams.has(LAUNCH_PARAM)) {
      named('/?key');
      if (!tokenMatches(token, url.searchParams.get(LAUNCH_PARAM) ?? undefined)) {
        throw new ReviewUiError(401, 'REVIEW_UI_NO_SESSION', 'this link is not valid');
      }
      send(res, 303, 'text/plain; charset=utf-8', '', {
        Location: '/',
        'Set-Cookie': sessionCookie(port, token),
      });
      return;
    }
    if (!tokenMatches(token, readCookie(header(req, 'cookie'), cookieName(port)))) {
      throw new ReviewUiError(
        401,
        'REVIEW_UI_NO_SESSION',
        'open the link printed by `recap review` in the terminal',
      );
    }
    const post = postRoutes
      .map((route) => ({ route, match: route.pattern.exec(url.pathname) }))
      .find((entry) => entry.match !== null);
    if (method === 'POST') {
      if (post?.match == null) {
        throw new ReviewUiError(404, 'REVIEW_UI_NOT_FOUND', 'no such action');
      }
      named(post.route.name);
      if (!stateChangeAllowed(header(req, 'origin'), header(req, 'sec-fetch-site'), port)) {
        throw new ReviewUiError(403, 'REVIEW_UI_BAD_ORIGIN', 'cross-origin requests are refused');
      }
      await handlePost(req, res, post.route, post.match);
      return;
    }
    if (method !== 'GET') {
      throw new ReviewUiError(405, 'REVIEW_UI_METHOD', 'method not allowed');
    }
    if (post?.match != null) {
      named(post.route.name);
      throw new ReviewUiError(405, 'REVIEW_UI_METHOD', 'method not allowed');
    }
    named(await handleGet(res, url.pathname));
  };

  const server: Server = createServer((req, res) => {
    const started = Date.now();
    let route = 'unmatched';
    const expectsJson = (): boolean =>
      (header(req, 'content-type') ?? '').includes('application/json') ||
      (req.url ?? '').startsWith('/api/');
    void handle(req, res, (name) => {
      route = name;
    })
      .catch((error: unknown) => {
        if (res.headersSent) {
          res.destroy();
          return;
        }
        const refusal = refusalOf(error);
        if (refusal !== undefined) {
          sendRefusal(res, refusal, expectsJson());
          logger.info('review-ui.refused', { route, errorCode: refusal.code });
          return;
        }
        logger.error('review-ui.unexpected-error', {
          route,
          errorCode: error instanceof Error ? error.name : 'unknown',
        });
        sendRefusal(
          res,
          new ReviewUiError(500, 'REVIEW_UI_INTERNAL', 'something went wrong; see the terminal'),
          expectsJson(),
        );
      })
      .finally(() => {
        logger.info('review-ui.request', {
          method: req.method,
          route,
          httpStatus: res.statusCode,
          durationMs: Date.now() - started,
        });
      });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: BIND_HOST, port: options.port ?? 0, exclusive: true }, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  port = address.port;
  logger.info('review-ui.started', { port });

  return {
    port,
    origin: originOf(port),
    launchUrl: `${originOf(port)}/?${LAUNCH_PARAM}=${token}`,
    token,
    close: async () => {
      await regenerator.close();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      });
      logger.info('review-ui.closed', { port });
    },
  };
}
