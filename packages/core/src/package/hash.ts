/**
 * Content hashing (ADR-004): every stored hash is `sha256:<64 lowercase hex>` of the raw bytes.
 * Files are streamed, so multi-hour audio never has to fit in memory.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export const HASH_PREFIX = 'sha256:';

export interface FileDigest {
  /** `sha256:<hex>` of the file bytes. */
  readonly hash: string;
  /** Number of bytes hashed. */
  readonly bytes: number;
}

/** `sha256:<hex>` of an in-memory buffer or string (UTF-8). */
export function sha256Bytes(data: string | Uint8Array): string {
  return `${HASH_PREFIX}${createHash('sha256').update(data).digest('hex')}`;
}

/** Streams `file` through sha256. Rejects on any read error (missing file, directory, lock). */
export async function sha256File(file: string): Promise<FileDigest> {
  const hash = createHash('sha256');
  let bytes = 0;
  const stream = createReadStream(file, { highWaterMark: 1 << 20 });
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { hash: `${HASH_PREFIX}${hash.digest('hex')}`, bytes };
}
