/**
 * Claude Code CLI harness (`claude -p`), spike quality.
 *
 *  - Spawns with an argument array and `shell: false` (no shell parsing).
 *  - Prompt/transcript is sent on stdin, never on the command line.
 *  - The argument list is a configurable template, because the exact flags
 *    (`--output-format`, `--json-schema`, `--tools`, `--disallowedTools`, ...)
 *    must be verified against the installed CLI version. `claude --version`
 *    is recorded with every run via `getCliVersion()`.
 *  - Working directory is a fresh, empty temp directory (removed afterwards);
 *    the harness reports whether anything was written into it.
 *  - Child env is an allowlist; API-key env vars are dropped unless the auth
 *    mode explicitly needs them (prevents silently billing an API key when the
 *    GM intends to use a subscription login, and vice versa).
 *  - Timeout and AbortSignal cancellation kill the whole process tree.
 *  - stdout and stderr are both byte-capped; stderr is redacted in full before
 *    the diagnostic tail is taken.
 *  - Output: JSON envelope parsed, structured output validated with Ajv.
 *
 * Nothing here is invoked by the unit tests against a real CLI; tests point
 * `command` at a fake executable.
 */
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractStructured, parseEnvelope, type CliEnvelope } from "./envelope.js";
import { defaultSpawn, killProcessTree, type KillTreeFn, type SpawnFn } from "./process.js";
import { Redactor, defaultRedactor } from "./redact.js";

export type AuthMode = "subscription-login" | "api-key-env";

export interface CliConfig {
  /** Executable. On Windows this must be a real .exe (or node + cli.js via prefixArgs), not a .cmd shim. */
  command: string;
  /** Args placed before the template (e.g. path to cli.js when command is node). */
  prefixArgs: string[];
  /** Explicit model id; never rely on the CLI default. */
  model: string;
  /**
   * Argument template. Elements equal to a placeholder are substituted as a
   * whole element: {model}, {schema}, {system}. Elements equal to "{tools}"
   * are replaced by `toolDisableArgs` (spread). Nothing is ever concatenated
   * into a shell string.
   */
  argTemplate: string[];
  /** Flags that disable tools. Configurable: verify against `claude --help`. */
  toolDisableArgs: string[];
  authMode: AuthMode;
  /** Env vars copied from the parent env (if set). */
  envAllowlist: string[];
  /** Extra env (tests use this to drive the fake CLI). */
  extraEnv?: Record<string, string>;
  /** Max bytes of stdout accepted before the run is aborted. */
  maxStdoutBytes: number;
  /** Max bytes of stderr buffered; beyond this the run is aborted (output_too_large). */
  maxStderrBytes: number;
  /** Grace period after kill before the harness stops waiting for 'close'. */
  killGraceMs: number;
}

export const TOOL_DISABLE_PRESETS = {
  /** All built-in tools disabled via an empty tool list (verify flag exists). */
  toolsEmpty: ["--tools", ""],
  /** Deny-list variant (verify flag spelling/format for the installed version). */
  disallowed: [
    "--disallowedTools",
    "Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch,NotebookEdit,Task,TodoWrite",
  ],
  /** Both, plus no MCP servers other than an empty explicit config (verify). */
  belt: [
    "--tools",
    "",
    "--disallowedTools",
    "Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch,NotebookEdit,Task,TodoWrite",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
  ],
} as const satisfies Record<string, readonly string[]>;

export const DEFAULT_ENV_ALLOWLIST = [
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "ComSpec",
  "windir",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "HOME",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
  "LANG",
  "NO_COLOR",
  // Claude Code config location override, if the GM uses one.
  "CLAUDE_CONFIG_DIR",
];

export function defaultCliConfig(overrides: Partial<CliConfig> = {}): CliConfig {
  return {
    command: "claude",
    prefixArgs: [],
    model: "claude-sonnet-5-5",
    argTemplate: [
      "-p",
      "--output-format",
      "json",
      "--model",
      "{model}",
      "--json-schema",
      "{schema}",
      "--system-prompt",
      "{system}",
      "{tools}",
    ],
    toolDisableArgs: [...TOOL_DISABLE_PRESETS.toolsEmpty],
    authMode: "subscription-login",
    envAllowlist: [...DEFAULT_ENV_ALLOWLIST],
    maxStdoutBytes: 10 * 1024 * 1024,
    maxStderrBytes: 1024 * 1024,
    killGraceMs: 5_000,
    ...overrides,
  };
}

export function buildArgs(config: CliConfig, vars: { schema: string; system: string }): string[] {
  const out = [...config.prefixArgs];
  for (const el of config.argTemplate) {
    if (el === "{tools}") out.push(...config.toolDisableArgs);
    else if (el === "{model}") out.push(config.model);
    else if (el === "{schema}") out.push(vars.schema);
    else if (el === "{system}") out.push(vars.system);
    else out.push(el);
  }
  return out;
}

export function buildChildEnv(config: CliConfig, parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of config.envAllowlist) if (parent[k] !== undefined) env[k] = parent[k];
  if (config.authMode === "api-key-env" && parent["ANTHROPIC_API_KEY"]) {
    env["ANTHROPIC_API_KEY"] = parent["ANTHROPIC_API_KEY"];
  }
  // Never pass these through in subscription-login mode, even if allowlisted.
  if (config.authMode === "subscription-login") {
    delete env["ANTHROPIC_API_KEY"];
    delete env["ANTHROPIC_AUTH_TOKEN"];
  }
  return { ...env, ...(config.extraEnv ?? {}) };
}

export type CliRunStatus =
  | "ok"
  | "schema_invalid"
  | "non_json"
  | "cli_error"
  | "exit_nonzero"
  | "timeout"
  | "cancelled"
  | "spawn_error"
  | "output_too_large";

export interface CliRunResult<T = unknown> {
  status: CliRunStatus;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  /** Redacted, truncated stderr tail for diagnostics. Never contains stdin. */
  stderrTail: string;
  envelope?: CliEnvelope;
  output?: T;
  outputSource?: "structured_output" | "result";
  validationErrors?: string[];
  detail?: string;
  /** Redacted argv with the schema/system values elided, for evidence. */
  argvForLog: string[];
  /** Entries found in the temp working dir after the run (expect []). */
  cwdEntriesAfter: string[];
}

export interface RunOptions<T> {
  config: CliConfig;
  stdin: string;
  schema: object;
  system: string;
  timeoutMs: number;
  signal?: AbortSignal;
  validate: (value: unknown) => { valid: true; value: T } | { valid: false; errors: string[] };
  spawnImpl?: SpawnFn;
  killTree?: KillTreeFn;
  redactor?: Redactor;
  parentEnv?: NodeJS.ProcessEnv;
}

export const STDERR_TAIL = 4_000;

/**
 * Redact the COMPLETE stderr first, then take the tail, so a cut can never
 * split a secret into an unrecognisable fragment. If the buffer itself was
 * capped (`truncated`), its last token may be a partial secret: drop
 * everything after the last whitespace before redacting.
 */
export function redactedTail(stderr: string, redactor: Redactor, max: number, truncated = false): string {
  let text = stderr;
  if (truncated) {
    const cut = text.search(/\s\S*$/);
    text = (cut >= 0 ? text.slice(0, cut + 1) : "") + "[stderr truncated]";
  }
  return redactor.redact(text).slice(-max);
}

export async function runClaudeCli<T>(opts: RunOptions<T>): Promise<CliRunResult<T>> {
  const {
    config,
    stdin,
    schema,
    system,
    timeoutMs,
    signal,
    validate,
    spawnImpl = defaultSpawn,
    killTree = killProcessTree,
    redactor = defaultRedactor,
    parentEnv = process.env,
  } = opts;

  const schemaJson = JSON.stringify(schema);
  const args = buildArgs(config, { schema: schemaJson, system });
  const argvForLog = [config.command, ...args].map((a) =>
    a === schemaJson ? "<schema>" : a === system ? "<system-prompt>" : redactor.redact(a),
  );
  const started = Date.now();
  const base = { argvForLog, exitCode: null, signal: null, stderrTail: "", cwdEntriesAfter: [] as string[] };

  if (signal?.aborted) {
    return { ...base, status: "cancelled", durationMs: 0, detail: "aborted before spawn" };
  }

  const cwd = await mkdtemp(join(tmpdir(), "s05-claude-cwd-"));
  try {
    // The abort listener is only attached at spawn time and does not replay
    // an abort that happened while mkdtemp() was pending: re-check here.
    if (signal?.aborted) {
      return { ...base, status: "cancelled", durationMs: Date.now() - started, detail: "aborted before spawn" };
    }
    const raw = await runProcess({
      command: config.command,
      args,
      cwd,
      env: buildChildEnv(config, parentEnv),
      stdin,
      timeoutMs,
      ...(signal ? { signal } : {}),
      maxStdoutBytes: config.maxStdoutBytes,
      maxStderrBytes: config.maxStderrBytes,
      killGraceMs: config.killGraceMs,
      spawnImpl,
      killTree,
    });
    const cwdEntriesAfter = await readdir(cwd).catch(() => [] as string[]);
    const common = {
      argvForLog,
      exitCode: raw.exitCode,
      signal: raw.signal,
      durationMs: Date.now() - started,
      stderrTail: redactedTail(raw.stderr, redactor, STDERR_TAIL, raw.stderrTruncated),
      cwdEntriesAfter,
    };

    if (raw.kind !== "exited") {
      return { ...common, status: raw.kind, detail: redactor.redact(raw.detail ?? raw.kind) };
    }

    const parsed = parseEnvelope(raw.stdout);
    if (!parsed.ok) {
      if (raw.exitCode !== 0) {
        return { ...common, status: "exit_nonzero", detail: `exit ${raw.exitCode}; ${parsed.detail}` };
      }
      return { ...common, status: "non_json", detail: parsed.detail };
    }
    const envelope = redactor.redactValue(parsed.envelope);
    if (envelope.isError) {
      return { ...common, envelope, status: "cli_error", detail: `envelope subtype=${envelope.subtype ?? "?"}` };
    }
    if (raw.exitCode !== 0) {
      return { ...common, envelope, status: "exit_nonzero", detail: `exit ${raw.exitCode}` };
    }
    const extracted = extractStructured(envelope);
    if (!extracted.ok) {
      return { ...common, envelope, status: "schema_invalid", validationErrors: [extracted.detail] };
    }
    const v = validate(extracted.value);
    if (!v.valid) {
      return {
        ...common,
        envelope,
        status: "schema_invalid",
        outputSource: extracted.source,
        validationErrors: v.errors,
      };
    }
    return { ...common, envelope, status: "ok", output: v.value, outputSource: extracted.source };
  } finally {
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  }
}

interface ProcessOutcome {
  kind: "exited" | "timeout" | "cancelled" | "spawn_error" | "output_too_large";
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** True when stderr hit maxStderrBytes and later bytes were discarded. */
  stderrTruncated: boolean;
  detail?: string;
}

interface RunProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: string;
  timeoutMs: number;
  signal?: AbortSignal;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  killGraceMs: number;
  spawnImpl: SpawnFn;
  killTree: KillTreeFn;
}

function runProcess(o: RunProcessOptions): Promise<ProcessOutcome> {
  return new Promise<ProcessOutcome>((resolve) => {
    let settled = false;
    let terminating: ProcessOutcome["kind"] | undefined;
    let terminateDetail: string | undefined;
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let errTruncated = false;

    let child: ReturnType<SpawnFn>;
    try {
      child = o.spawnImpl(o.command, o.args, {
        cwd: o.cwd,
        env: o.env,
        shell: false,
        windowsHide: true,
        // POSIX: own process group so the whole tree can be killed.
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      resolve({
        kind: "spawn_error",
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: "",
        stderrTruncated: false,
        detail: (e as Error).message,
      });
      return;
    }

    const finish = (r: ProcessOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      o.signal?.removeEventListener("abort", onAbort);
      resolve(r);
    };

    let graceTimer: NodeJS.Timeout | undefined;
    const terminate = (kind: ProcessOutcome["kind"], detail: string) => {
      if (terminating || settled) return;
      terminating = kind;
      terminateDetail = detail;
      if (child.pid !== undefined) void o.killTree(child.pid);
      else child.kill("SIGKILL");
      // If 'close' never arrives (e.g. a grandchild holds the pipes), stop waiting.
      graceTimer = setTimeout(
        () =>
          finish({
            kind,
            exitCode: null,
            signal: null,
            stdout: Buffer.concat(out).toString("utf8"),
            stderr: Buffer.concat(err).toString("utf8"),
            stderrTruncated: errTruncated,
            detail: `${detail}; process did not close within ${o.killGraceMs}ms of kill`,
          }),
        o.killGraceMs,
      );
    };

    const timer = setTimeout(() => terminate("timeout", `timed out after ${o.timeoutMs}ms`), o.timeoutMs);
    const onAbort = () => terminate("cancelled", "aborted by caller");
    o.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (d: Buffer) => {
      outBytes += d.length;
      if (outBytes > o.maxStdoutBytes) {
        terminate("output_too_large", `stdout exceeded ${o.maxStdoutBytes} bytes`);
        return;
      }
      out.push(d);
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (errTruncated) return;
      errBytes += d.length;
      if (errBytes > o.maxStderrBytes) {
        // Keep what fits, discard the rest, stop the run: memory stays bounded.
        const room = o.maxStderrBytes - (errBytes - d.length);
        if (room > 0) err.push(d.subarray(0, room));
        errTruncated = true;
        terminate("output_too_large", `stderr exceeded ${o.maxStderrBytes} bytes`);
        return;
      }
      err.push(d);
    });
    child.once("error", (e) => {
      finish({
        kind: terminating ?? "spawn_error",
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: Buffer.concat(err).toString("utf8"),
        stderrTruncated: errTruncated,
        detail: e.message,
      });
    });
    child.once("close", (code, sig) => {
      const base = {
        exitCode: code,
        signal: sig,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        stderrTruncated: errTruncated,
      };
      if (terminating) finish({ ...base, kind: terminating, ...(terminateDetail ? { detail: terminateDetail } : {}) });
      else finish({ ...base, kind: "exited" });
    });

    // stdin: write the whole prompt, then close. EPIPE (child exited early) is ignored.
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(o.stdin, "utf8");
  });
}

/** Run `<command> [...prefixArgs] --version` and return trimmed stdout (or an error string). */
export async function getCliVersion(
  config: Pick<CliConfig, "command" | "prefixArgs" | "envAllowlist" | "authMode" | "extraEnv">,
  { spawnImpl = defaultSpawn, timeoutMs = 15_000 }: { spawnImpl?: SpawnFn; timeoutMs?: number } = {},
): Promise<{ ok: boolean; version: string }> {
  const cwd = await mkdtemp(join(tmpdir(), "s05-claude-ver-"));
  try {
    const full = defaultCliConfig({ ...config });
    const r = await runProcess({
      command: config.command,
      args: [...config.prefixArgs, "--version"],
      cwd,
      env: buildChildEnv(full),
      stdin: "",
      timeoutMs,
      maxStdoutBytes: 64 * 1024,
      maxStderrBytes: 64 * 1024,
      killGraceMs: 2_000,
      spawnImpl,
      killTree: killProcessTree,
    });
    if (r.kind === "exited" && r.exitCode === 0) return { ok: true, version: r.stdout.trim() };
    const stderr = redactedTail(r.stderr, defaultRedactor, 500, r.stderrTruncated);
    return { ok: false, version: defaultRedactor.redact(`${r.kind} exit=${r.exitCode} ${r.detail ?? ""} ${stderr}`.trim()) };
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
  }
}
