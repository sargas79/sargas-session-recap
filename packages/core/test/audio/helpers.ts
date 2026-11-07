import { readFileSync } from 'node:fs';
import type { RunToolOptions, RunToolResult, ToolRunner } from '../../src/audio/index.ts';

export function fixture(name: string): string {
  return readFileSync(new URL(`../fixtures/audio/${name}`, import.meta.url), 'utf8');
}

export interface FakeCall {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: RunToolOptions;
}

/** A runner that never spawns anything and answers from `respond`. */
export function fakeRunner(respond: (call: FakeCall) => Partial<RunToolResult>): {
  runner: ToolRunner;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  const runner: ToolRunner = (file, args, options) => {
    const call = { file, args, options };
    calls.push(call);
    const response = respond(call);
    return Promise.resolve({
      exitCode: 0,
      signal: null,
      stdout: '',
      stderr: '',
      ...response,
    });
  };
  return { runner, calls };
}

/** Fake `-version` output for whichever tool is asked. */
export function versionRunner(version: string): ReturnType<typeof fakeRunner> {
  return fakeRunner(({ options }) => ({
    stdout: `${options.tool} version ${version} Copyright (c) 2000-2025 the FFmpeg developers\n`,
  }));
}
