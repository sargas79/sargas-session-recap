/**
 * Per-speaker fragment file (THROWAWAY spike).
 *
 * Lifecycle: create `<name>.wav.part` with a placeholder WAV header -> append PCM synchronously (no
 * user-space buffering, so a process kill loses only what never reached write()) -> fsync every
 * `flushIntervalMs` (bounds loss on an OS crash / power cut) -> finalize: patch header sizes, fsync,
 * close, rename `.part` -> `<name>.wav` with bounded retry (Windows may return EPERM/EBUSY/EACCES while
 * antivirus or the indexer holds a handle).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { WAV_HEADER_BYTES, wavHeader, type PcmFormat } from "./wav.js";

export const PART_SUFFIX = ".part";

const RETRYABLE = new Set(["EPERM", "EBUSY", "EACCES"]);

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function renameWithRetry(
  from: string,
  to: string,
  opts: { attempts?: number; baseDelayMs?: number; rename?: (a: string, b: string) => void } = {},
): number {
  const attempts = opts.attempts ?? 6;
  const base = opts.baseDelayMs ?? 25;
  const rename = opts.rename ?? fs.renameSync;
  for (let i = 1; ; i++) {
    try {
      rename(from, to);
      return i;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (!RETRYABLE.has(code) || i >= attempts) throw err;
      sleepSync(base * 2 ** (i - 1));
    }
  }
}

export class FragmentWriter {
  readonly partPath: string;
  readonly finalPath: string;
  private fd: number | null;
  private dataBytes = 0;
  private lastFsyncMs: number;

  constructor(
    dir: string,
    baseName: string,
    private readonly fmt: PcmFormat,
    private readonly flushIntervalMs: number,
    private readonly nowMs: () => number,
  ) {
    this.finalPath = path.join(dir, `${baseName}.wav`);
    this.partPath = this.finalPath + PART_SUFFIX;
    this.fd = fs.openSync(this.partPath, "wx");
    fs.writeSync(this.fd, wavHeader(0, fmt));
    this.lastFsyncMs = nowMs();
  }

  write(pcm: Int16Array): void {
    if (this.fd === null) throw new Error("fragment already finalized");
    const buf = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    fs.writeSync(this.fd, buf);
    this.dataBytes += buf.length;
    const now = this.nowMs();
    if (now - this.lastFsyncMs >= this.flushIntervalMs) {
      fs.fsyncSync(this.fd);
      this.lastFsyncMs = now;
    }
  }

  writeSilence(samples: number): void {
    if (samples > 0) this.write(new Int16Array(samples * this.fmt.channels));
  }

  get bytesWritten(): number {
    return this.dataBytes;
  }

  /** Patches the header, fsyncs, closes and renames. Returns the final path. Idempotent-safe: throws if called twice. */
  finalize(renameOpts?: Parameters<typeof renameWithRetry>[2]): string {
    if (this.fd === null) throw new Error("fragment already finalized");
    fs.writeSync(this.fd, wavHeader(this.dataBytes, this.fmt), 0, WAV_HEADER_BYTES, 0);
    fs.fsyncSync(this.fd);
    fs.closeSync(this.fd);
    this.fd = null;
    renameWithRetry(this.partPath, this.finalPath, renameOpts);
    return this.finalPath;
  }
}
