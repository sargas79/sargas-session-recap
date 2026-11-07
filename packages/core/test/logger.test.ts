import { describe, expect, it } from 'vitest';
import { createLogger, DEFAULT_ALLOWED_FIELDS, type LogRecord } from '../src/log/index.ts';

const FIXED_NOW = new Date('2026-01-01T00:00:00.000Z');

function capture(options: Parameters<typeof createLogger>[0] = {}) {
  const lines: string[] = [];
  const logger = createLogger({
    ...options,
    sink: (line) => lines.push(line),
    now: () => FIXED_NOW,
  });
  const records = (): LogRecord[] => lines.map((line) => JSON.parse(line) as LogRecord);
  return { logger, lines, records };
}

describe('logger redaction allowlist', () => {
  it('emits the envelope and allowed fields', () => {
    const { logger, records } = capture();
    logger.info('job.finished', { jobId: 'job-1', durationMs: 42, status: 'ok' });
    expect(records()).toEqual([
      {
        ts: '2026-01-01T00:00:00.000Z',
        level: 'info',
        event: 'job.finished',
        jobId: 'job-1',
        durationMs: 42,
        status: 'ok',
      },
    ]);
  });

  it('never emits unlisted fields such as text or apiKey', () => {
    const { logger, lines, records } = capture();
    const secretText = 'the party betrayed the duke';
    const secretKey = 'sk-test-0000000000';
    logger.info('segment.classified', {
      jobId: 'job-2',
      text: secretText,
      apiKey: secretKey,
      prompt: 'system prompt body',
      token: 'abc',
    });
    const [record] = records();
    expect(record).toBeDefined();
    expect(record).not.toHaveProperty('text');
    expect(record).not.toHaveProperty('apiKey');
    expect(record).not.toHaveProperty('prompt');
    expect(record).not.toHaveProperty('token');
    expect(record?.['jobId']).toBe('job-2');
    expect(record?.redacted).toBe(4);
    const raw = lines.join('\n');
    expect(raw).not.toContain(secretText);
    expect(raw).not.toContain(secretKey);
    expect(raw).not.toContain('apiKey');
    expect(raw).not.toContain('text');
  });

  it('drops non-primitive values even for allowed field names', () => {
    const { logger, lines, records } = capture();
    logger.info('nested', { jobId: { text: 'leak', apiKey: 'k' }, count: [1, 2] });
    expect(records()[0]).not.toHaveProperty('jobId');
    expect(records()[0]).not.toHaveProperty('count');
    expect(records()[0]?.redacted).toBe(2);
    expect(lines.join('\n')).not.toContain('leak');
  });

  it('does not let fields override the envelope', () => {
    const { logger, records } = capture({ allow: ['level', 'event'] });
    logger.warn('real.event', { level: 'debug', event: 'spoofed', ts: 'x' });
    const [record] = records();
    expect(record?.level).toBe('warn');
    expect(record?.event).toBe('real.event');
    expect(record?.ts).toBe('2026-01-01T00:00:00.000Z');
  });

  it('extends the allowlist explicitly via options and child loggers', () => {
    const { logger, records } = capture({ allow: ['segmentCount'] });
    logger.child(['chunkIndex']).info('chunk.done', { segmentCount: 3, chunkIndex: 7, text: 'no' });
    expect(records()[0]).toMatchObject({ segmentCount: 3, chunkIndex: 7, redacted: 1 });
    expect(records()[0]).not.toHaveProperty('text');
  });

  it('respects the minimum level', () => {
    const { logger, records } = capture({ level: 'warn' });
    logger.debug('a');
    logger.info('b');
    logger.warn('c');
    logger.error('d');
    expect(records().map((r) => r.event)).toEqual(['c', 'd']);
  });

  it('keeps content-bearing names out of the default allowlist', () => {
    for (const name of ['text', 'apiKey', 'token', 'prompt', 'transcript', 'secret', 'password']) {
      expect(DEFAULT_ALLOWED_FIELDS).not.toContain(name);
    }
  });
});
