/**
 * Streams a pinned file to disk and verifies it (T23). Everything goes to `<dest>.partial`, and only
 * a file with the pinned size and sha256 is renamed to `dest`. Any failure deletes the partial file,
 * so a corrupt, truncated or tampered download never survives. A process killed mid-download leaves
 * only the `.partial` file, which is never treated as installed and is overwritten by the next run.
 */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { commitFileAtomic } from '../package/atomic.ts';
import { HASH_PREFIX } from '../package/hash.ts';
import { ToolsError } from './errors.ts';
import { isAllowedDownloadUrl } from './lock.ts';

export interface DownloadTarget {
  readonly url: string;
  readonly dest: string;
  /** `sha256:<hex>` pinned in the lock. */
  readonly sha256: string;
  /** Size pinned in the lock. */
  readonly bytes: number;
}

export interface DownloadOptions {
  /** Test seam. Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly onProgress?: ((received: number, total: number) => void) | undefined;
}

async function open(target: DownloadTarget, options: DownloadOptions): Promise<Response> {
  if (!isAllowedDownloadUrl(target.url)) {
    throw new ToolsError('TOOLS_DOWNLOAD_FAILED', `refusing to download from ${target.url}`);
  }
  const doFetch = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await doFetch(target.url, {
      redirect: 'follow',
      headers: { 'accept-encoding': 'identity' },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (cause) {
    throw new ToolsError(
      'TOOLS_DOWNLOAD_FAILED',
      `could not reach ${target.url}`,
      'check the connection and re-run',
      cause,
    );
  }
  // A redirect could have left https; the hash would catch a bad file, but refuse it outright.
  if (!isAllowedDownloadUrl(response.url === '' ? target.url : response.url)) {
    await response.body?.cancel();
    throw new ToolsError('TOOLS_DOWNLOAD_FAILED', `${target.url} redirected to a non-https URL`);
  }
  if (response.status !== 200 || response.body === null) {
    await response.body?.cancel();
    throw new ToolsError(
      'TOOLS_DOWNLOAD_FAILED',
      `${target.url} answered HTTP ${String(response.status)}`,
    );
  }
  return response;
}

/**
 * Downloads `target.url` to `target.dest`. Rejects with `TOOLS_DOWNLOAD_*` or
 * `TOOLS_HASH_MISMATCH`; in every failure case nothing is left on disk.
 */
export async function downloadVerified(
  target: DownloadTarget,
  options: DownloadOptions = {},
): Promise<void> {
  const { dest, bytes: total } = target;
  const partial = `${dest}.partial`;
  await mkdir(path.dirname(dest), { recursive: true });
  try {
    const response = await open(target, options);
    const body = response.body as unknown as WebReadableStream<Uint8Array>;
    const hash = createHash('sha256');
    let received = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        received += chunk.length;
        if (received > total) {
          // Abort at once: never write more than the pinned size to disk.
          done(new ToolsError('TOOLS_DOWNLOAD_TOO_LARGE', `${target.url} is larger than pinned`));
          return;
        }
        hash.update(chunk);
        options.onProgress?.(received, total);
        done(null, chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(body), meter, createWriteStream(partial, { flags: 'w' }));
    } catch (cause) {
      if (cause instanceof ToolsError) throw cause;
      throw new ToolsError(
        'TOOLS_DOWNLOAD_INCOMPLETE',
        `the download of ${target.url} was interrupted`,
        're-run `recap setup whisper`',
        cause,
      );
    }
    if (received !== total) {
      throw new ToolsError(
        'TOOLS_DOWNLOAD_INCOMPLETE',
        `${target.url} sent ${String(received)} of ${String(total)} bytes`,
        're-run `recap setup whisper`',
      );
    }
    const actual = `${HASH_PREFIX}${hash.digest('hex')}`;
    if (actual !== target.sha256) {
      throw new ToolsError(
        'TOOLS_HASH_MISMATCH',
        `${target.url} does not match the sha256 in tools.lock.json (got ${actual})`,
        'the file was corrupted or replaced at the source; it was deleted',
      );
    }
    await commitFileAtomic(partial, dest);
  } catch (error) {
    await rm(partial, { force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined);
    throw error;
  }
}
