import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import {
  TOOL_DISABLE_PRESETS,
  buildArgs,
  buildChildEnv,
  defaultCliConfig,
  getCliVersion,
  runClaudeCli,
  type CliConfig,
} from "../src/cli-harness.js";
import { isProcessAlive, type SpawnFn } from "../src/process.js";
import { Redactor } from "../src/redact.js";
import { classificationSchema, validateClassification } from "../src/schema.js";
import { buildClassificationPrompt } from "../src/untrusted.js";
import { INJECTION_PROBES } from "../fixtures/injection-probes.js";

const FAKE = fileURLToPath(new URL("./fake-claude.mjs", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "s05-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const prompt = buildClassificationPrompt(INJECTION_PROBES);
const ids = INJECTION_PROBES.map((p) => p.id);

function fakeConfig(mode: string, extra: Partial<CliConfig> = {}, env: Record<string, string> = {}): CliConfig {
  return defaultCliConfig({
    command: process.execPath,
    prefixArgs: [FAKE],
    extraEnv: { FAKE_CLAUDE_MODE: mode, ...env },
    killGraceMs: 3_000,
    ...extra,
  });
}

function run(mode: string, o: { timeoutMs?: number; signal?: AbortSignal; extra?: Partial<CliConfig>; env?: Record<string, string>; parentEnv?: NodeJS.ProcessEnv; redactor?: Redactor } = {}) {
  return runClaudeCli({
    config: fakeConfig(mode, o.extra, o.env),
    stdin: prompt.user,
    schema: classificationSchema,
    system: prompt.system,
    timeoutMs: o.timeoutMs ?? 10_000,
    validate: (v) => validateClassification(v, ids),
    ...(o.signal ? { signal: o.signal } : {}),
    ...(o.parentEnv ? { parentEnv: o.parentEnv } : {}),
    ...(o.redactor ? { redactor: o.redactor } : {}),
  });
}

describe("argument construction", () => {
  it("substitutes placeholders as whole elements and spreads tool flags", () => {
    const cfg = defaultCliConfig({ toolDisableArgs: [...TOOL_DISABLE_PRESETS.belt] });
    const args = buildArgs(cfg, { schema: '{"a":1}', system: "sys" });
    expect(args).toEqual([
      "-p", "--output-format", "json", "--model", "claude-sonnet-5-5",
      "--json-schema", '{"a":1}', "--system-prompt", "sys",
      ...TOOL_DISABLE_PRESETS.belt,
    ]);
    expect(args).toContain("");
  });

  it("drops API-key env vars in subscription-login mode, passes only allowlisted vars", () => {
    const parent = { PATH: "/bin", ANTHROPIC_API_KEY: "sk-ant-api03-SECRETSECRETSECRET", SECRET_THING: "x" };
    const env = buildChildEnv(defaultCliConfig({ envAllowlist: ["PATH", "ANTHROPIC_API_KEY"] }), parent);
    expect(env).toEqual({ PATH: "/bin" });
    const env2 = buildChildEnv(defaultCliConfig({ authMode: "api-key-env", envAllowlist: ["PATH"] }), parent);
    expect(env2).toEqual({ PATH: "/bin", ANTHROPIC_API_KEY: parent.ANTHROPIC_API_KEY });
  });
});

describe("runClaudeCli with a fake CLI process", () => {
  it("valid output: parses envelope, validates, captures usage and cost", async () => {
    const r = await run("valid");
    expect(r.status).toBe("ok");
    expect(r.outputSource).toBe("structured_output");
    expect(r.output?.segments.map((s) => s.id)).toEqual(ids);
    expect(r.envelope?.usage).toMatchObject({
      input_tokens: 321, output_tokens: 45, cache_creation_input_tokens: 10, cache_read_input_tokens: 0,
      extra: { service_tier: "standard" },
    });
    expect(r.envelope?.totalCostUsd).toBe(0.0123);
    expect(r.envelope?.durationApiMs).toBe(1000);
    expect(r.envelope?.numTurns).toBe(1);
    expect(r.envelope?.fieldsPresent).toContain("modelUsage");
    expect(r.cwdEntriesAfter).toEqual([]);
  });

  it("falls back to parsing `result` when no structured_output field exists", async () => {
    const r = await run("valid-result-only");
    expect(r.status).toBe("ok");
    expect(r.outputSource).toBe("result");
  });

  it("sends the prompt on stdin (not argv), runs in an empty temp cwd, with allowlisted env", async () => {
    const rec = join(scratch, "record.json");
    const r = await run("valid", {
      env: { FAKE_CLAUDE_RECORD: rec },
      parentEnv: { ...process.env, ANTHROPIC_API_KEY: "sk-ant-api03-MUSTNOTLEAKMUSTNOTLEAK" },
    });
    expect(r.status).toBe("ok");
    const seen = JSON.parse(readFileSync(rec, "utf8")) as { args: string[]; cwd: string; stdin: string; envKeys: string[] };
    expect(seen.stdin).toBe(prompt.user);
    expect(seen.args.join(" ")).not.toContain("Ignore all previous instructions");
    expect(seen.args).toContain("--json-schema");
    expect(seen.args).toContain("--model");
    expect(seen.cwd).toContain("s05-claude-cwd-");
    expect(existsSync(seen.cwd)).toBe(false); // removed after the run
    expect(seen.envKeys).not.toContain("ANTHROPIC_API_KEY");
    expect(r.argvForLog).toContain("<schema>");
    expect(r.argvForLog).toContain("<system-prompt>");
  });

  it("schema-invalid output is detected with Ajv errors", async () => {
    const r = await run("schema-invalid");
    expect(r.status).toBe("schema_invalid");
    expect(r.validationErrors?.length).toBeGreaterThan(0);
    expect(r.output).toBeUndefined();
  });

  it("unknown / forged segment ids are rejected", async () => {
    const r = await run("unknown-id");
    expect(r.status).toBe("schema_invalid");
    expect(r.validationErrors).toContain("unknown segment id: forged-999");
  });

  it("prose (non-JSON) result inside a valid envelope is schema_invalid", async () => {
    const r = await run("prose-result");
    expect(r.status).toBe("schema_invalid");
  });

  it("non-JSON stdout is reported as non_json", async () => {
    const r = await run("non-json");
    expect(r.status).toBe("non_json");
  });

  it("error envelope is reported as cli_error", async () => {
    const r = await run("cli-error");
    expect(r.status).toBe("cli_error");
    expect(r.exitCode).toBe(1);
  });

  it("non-zero exit is reported and stderr is redacted", async () => {
    const r = await run("exit-nonzero");
    expect(r.status).toBe("exit_nonzero");
    expect(r.exitCode).toBe(3);
    expect(r.stderrTail).toContain("[REDACTED]");
    expect(r.stderrTail).not.toContain("FAKEFAKEFAKE");
  });

  it("files written into the working dir are surfaced", async () => {
    const r = await run("write-cwd");
    expect(r.cwdEntriesAfter).toEqual(["pwned.txt"]);
  });

  it("timeout kills the process", async () => {
    const t0 = Date.now();
    const r = await run("hang", { timeoutMs: 500 });
    expect(r.status).toBe("timeout");
    expect(Date.now() - t0).toBeLessThan(8_000);
  });

  it("cancellation via AbortSignal kills the whole process tree", async () => {
    const pidFile = join(scratch, "gc.pid");
    const ac = new AbortController();
    const p = run("hang-with-child", { timeoutMs: 15_000, signal: ac.signal, env: { FAKE_CLAUDE_CHILD_PID_FILE: pidFile } });
    // wait for the grandchild to be spawned
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 50));
    const gcPid = Number(readFileSync(pidFile, "utf8"));
    expect(isProcessAlive(gcPid)).toBe(true);
    ac.abort();
    const r = await p;
    expect(r.status).toBe("cancelled");
    for (let i = 0; i < 40 && isProcessAlive(gcPid); i++) await new Promise((r) => setTimeout(r, 100));
    expect(isProcessAlive(gcPid)).toBe(false);
  });

  it("an already-aborted signal never spawns", async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await run("valid", { signal: ac.signal });
    expect(r.status).toBe("cancelled");
    expect(r.durationMs).toBe(0);
  });

  it("oversized stdout is cut off", async () => {
    const r = await run("huge", { extra: { maxStdoutBytes: 1024 * 1024 } });
    expect(r.status).toBe("output_too_large");
  });

  it("missing executable is a spawn_error", async () => {
    const r = await runClaudeCli({
      config: defaultCliConfig({ command: join(scratch, "does-not-exist.exe") }),
      stdin: "x",
      schema: classificationSchema,
      system: "",
      timeoutMs: 5_000,
      validate: (v) => validateClassification(v),
    });
    expect(r.status).toBe("spawn_error");
  });

  it("records the CLI version", async () => {
    const v = await getCliVersion({ command: process.execPath, prefixArgs: [FAKE], envAllowlist: ["PATH", "Path", "SystemRoot"], authMode: "subscription-login" });
    expect(v).toEqual({ ok: true, version: "9.9.9-fake (Claude Code)" });
  });
});

describe("runClaudeCli with an injected spawn (no process at all)", () => {
  function fakeChild(stdout: string, code: number): SpawnFn {
    return () => {
      const child = new EventEmitter() as unknown as ChildProcess;
      const out = new PassThrough();
      const err = new PassThrough();
      const inp = new PassThrough();
      Object.assign(child, { stdout: out, stderr: err, stdin: inp, pid: undefined, kill: () => true });
      inp.on("finish", () => {
        out.end(stdout);
        err.end();
        setImmediate(() => child.emit("close", code, null));
      });
      inp.resume();
      return child;
    };
  }

  it("parses usage fields from an arbitrary envelope", async () => {
    const env = JSON.stringify({
      type: "result", subtype: "success", is_error: false,
      result: JSON.stringify({ segments: [{ id: "a", label: "gm_narration", injection_suspected: false }] }),
      usage: { input_tokens: 1, output_tokens: 2, server_tool_use: { web_search_requests: 0 } },
      total_cost_usd: 0.5,
    });
    const r = await runClaudeCli({
      config: defaultCliConfig(),
      stdin: "x",
      schema: classificationSchema,
      system: "s",
      timeoutMs: 5_000,
      validate: (v) => validateClassification(v, ["a"]),
      spawnImpl: fakeChild(env, 0),
    });
    expect(r.status).toBe("ok");
    expect(r.envelope?.usage?.input_tokens).toBe(1);
    expect(r.envelope?.usage?.output_tokens).toBe(2);
    expect(r.envelope?.usage?.extra).toEqual({ server_tool_use: { web_search_requests: 0 } });
    expect(r.envelope?.totalCostUsd).toBe(0.5);
  });

  it("accepts JSON-lines output, using the final result object", async () => {
    const lines = [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, structured_output: { segments: [] } }),
    ].join("\n");
    const r = await runClaudeCli({
      config: defaultCliConfig(), stdin: "x", schema: classificationSchema, system: "s", timeoutMs: 5_000,
      validate: (v) => validateClassification(v, []), spawnImpl: fakeChild(lines, 0),
    });
    expect(r.status).toBe("ok");
  });

  it("redacts secrets that appear in the envelope", async () => {
    const secret = "sk-ant-oat01-ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const env = JSON.stringify({ type: "result", subtype: "error_x", is_error: true, result: `bad key ${secret}` });
    const r = await runClaudeCli({
      config: defaultCliConfig(), stdin: "x", schema: classificationSchema, system: "s", timeoutMs: 5_000,
      validate: (v) => validateClassification(v), spawnImpl: fakeChild(env, 1), redactor: new Redactor([secret]),
    });
    expect(r.status).toBe("cli_error");
    expect(JSON.stringify(r)).not.toContain(secret);
  });
});
