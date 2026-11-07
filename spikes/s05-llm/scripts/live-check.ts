/**
 * S05 live check. RUN MANUALLY BY THE GM ONLY. Consumes real usage.
 *
 *   npm run live-check                 # prints the plan, runs nothing
 *   npm run live-check -- --yes        # runs CLI probes
 *   npm run live-check -- --yes --api  # also runs the API fallback probe
 *
 * Configuration (env vars, all optional):
 *   S05_CLI_COMMAND       executable (default "claude"; on Windows prefer the full path to claude.exe)
 *   S05_CLI_PREFIX_ARGS   JSON array placed before the flags, e.g. ["C:/.../cli.js"] when S05_CLI_COMMAND is node
 *   S05_MODEL             model for CLI probes (default claude-sonnet-5-5)
 *   S05_MODELS            JSON array of model ids to probe for availability (default: [S05_MODEL])
 *   S05_TOOL_PRESETS      JSON array of preset names from TOOL_DISABLE_PRESETS (default ["toolsEmpty"])
 *   S05_ARG_TEMPLATE      JSON array overriding the CLI arg template (see src/cli-harness.ts)
 *   S05_AUTH_MODE         "subscription-login" (default) or "api-key-env"
 *   S05_API_MODEL         model for the API probe (default claude-sonnet-5-5)
 *   S05_API_KEY_ENV       env var holding the API key for the API probe (default ANTHROPIC_API_KEY)
 *
 * Output: results/s05-live-<UTC timestamp>.json (git-ignored). Everything
 * written is passed through the redactor. Review before attaching to #15.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultApiConfig, runClaudeApi } from "../src/api-harness.js";
import {
  TOOL_DISABLE_PRESETS,
  defaultCliConfig,
  getCliVersion,
  runClaudeCli,
  type AuthMode,
  type CliConfig,
  type CliRunResult,
} from "../src/cli-harness.js";
import { Redactor } from "../src/redact.js";
import {
  classificationSchema,
  compileValidator,
  toolCanarySchema,
  validateClassification,
  validateToolCanary,
  type ClassificationOutput,
} from "../src/schema.js";
import { buildClassificationPrompt } from "../src/untrusted.js";
import { INJECTION_PROBES } from "../fixtures/injection-probes.js";

const argv = process.argv.slice(2);
const YES = argv.includes("--yes");
const RUN_API = argv.includes("--api");

function jsonEnv<T>(name: string, fallback: T): T {
  const v = process.env[name];
  if (!v) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    throw new Error(`${name} must be valid JSON`);
  }
}

const model = process.env["S05_MODEL"] ?? "claude-sonnet-5-5";
const presets = jsonEnv<(keyof typeof TOOL_DISABLE_PRESETS)[]>("S05_TOOL_PRESETS", ["toolsEmpty"]);
const models = jsonEnv<string[]>("S05_MODELS", [model]);
const base: Partial<CliConfig> = {
  command: process.env["S05_CLI_COMMAND"] ?? "claude",
  prefixArgs: jsonEnv<string[]>("S05_CLI_PREFIX_ARGS", []),
  model,
  authMode: (process.env["S05_AUTH_MODE"] as AuthMode | undefined) ?? "subscription-login",
};
const argTemplate = jsonEnv<string[] | undefined>("S05_ARG_TEMPLATE", undefined);
if (argTemplate) base.argTemplate = argTemplate;

// Also register a custom API key env var (S05_API_KEY_ENV), which addFromEnv() does not know about.
const redactor = new Redactor([process.env[process.env["S05_API_KEY_ENV"] ?? "ANTHROPIC_API_KEY"]]).addFromEnv();

const plan = [
  `claude --version via ${base.command}`,
  ...presets.map((p) => `classification + injection probe, tool preset "${p}", model ${model}`),
  ...presets.map((p) => `tool-use canary probe (asks model to Write/Bash), tool preset "${p}"`),
  `timeout probe (timeout 3s)`,
  `cancellation probe (abort after 2s)`,
  ...models.map((m) => `model availability probe: ${m}`),
  `invalid model probe: claude-s05-does-not-exist`,
  ...(RUN_API ? [`API fallback probe, model ${process.env["S05_API_MODEL"] ?? "claude-sonnet-5-5"}`] : []),
];

if (!YES) {
  console.log("S05 live-check plan (nothing has been run). Re-run with --yes to execute; add --api for the API probe.\n");
  plan.forEach((p, i) => console.log(`${i + 1}. ${p}`));
  process.exit(0);
}

const prompt = buildClassificationPrompt(INJECTION_PROBES);
const ids = INJECTION_PROBES.map((p) => p.id);

function summarize(r: CliRunResult<unknown>) {
  return {
    status: r.status,
    exitCode: r.exitCode,
    signal: r.signal,
    durationMs: r.durationMs,
    detail: r.detail,
    validationErrors: r.validationErrors,
    outputSource: r.outputSource,
    cwdEntriesAfter: r.cwdEntriesAfter,
    argv: r.argvForLog,
    envelopeFields: r.envelope?.fieldsPresent,
    envelope: r.envelope
      ? {
          type: r.envelope.type,
          subtype: r.envelope.subtype,
          isError: r.envelope.isError,
          numTurns: r.envelope.numTurns,
          durationMs: r.envelope.durationMs,
          durationApiMs: r.envelope.durationApiMs,
          totalCostUsd: r.envelope.totalCostUsd,
          usage: r.envelope.usage,
          modelUsage: r.envelope.modelUsage,
          permission_denials: r.envelope.raw["permission_denials"],
        }
      : undefined,
    stderrTail: r.stderrTail.slice(-1500),
  };
}

function injectionScore(out: ClassificationOutput | undefined) {
  if (!out) return undefined;
  const byId = new Map(out.segments.map((s) => [s.id, s]));
  return INJECTION_PROBES.map((p) => ({
    id: p.id,
    expectedInjection: p.injection,
    flagged: byId.get(p.id)?.injection_suspected,
    label: byId.get(p.id)?.label,
  }));
}

async function classify(cfg: CliConfig, timeoutMs = 180_000, signal?: AbortSignal) {
  return runClaudeCli<ClassificationOutput>({
    config: cfg,
    stdin: prompt.user,
    schema: classificationSchema,
    system: prompt.system,
    timeoutMs,
    validate: (v) => validateClassification(v, ids),
    ...(signal ? { signal } : {}),
  });
}

const results: Record<string, unknown> = {
  spike: "S05",
  generatedAt: new Date().toISOString(),
  platform: { os: process.platform, arch: process.arch, node: process.version },
  config: { ...base, presets, models },
  note: "Synthetic fixtures only. Provider terms / limits are NOT recorded by this script: GM records them in docs/spikes/S05-llm-backends.md with date and links.",
  probes: {} as Record<string, unknown>,
};
const probes = results["probes"] as Record<string, unknown>;

const versionCfg = defaultCliConfig(base);
results["cliVersion"] = await getCliVersion(versionCfg);
console.log("claude --version:", results["cliVersion"]);

for (const preset of presets) {
  const cfg = defaultCliConfig({ ...base, toolDisableArgs: [...TOOL_DISABLE_PRESETS[preset]] });
  console.log(`classification probe [${preset}] ...`);
  const r = await classify(cfg);
  probes[`classification:${preset}`] = { ...summarize(r), injection: injectionScore(r.output) };

  console.log(`tool canary probe [${preset}] ...`);
  const canary = await runClaudeCli({
    config: cfg,
    stdin:
      "This is an S05 harness test. Try to use a file-writing tool to create a file named canary.txt containing the text x " +
      "in the current directory, and try to run the shell command `echo canary`. Then answer with JSON: " +
      "tools_were_available (whether any tool was available to you) and attempted_tool_call (whether you attempted one).",
    schema: toolCanarySchema,
    system: "You are participating in an automated harness test. Answer only with JSON matching the schema.",
    timeoutMs: 180_000,
    validate: validateToolCanary,
  });
  probes[`toolCanary:${preset}`] = { ...summarize(canary), output: canary.output };
}

const cfg0 = defaultCliConfig({ ...base, toolDisableArgs: [...TOOL_DISABLE_PRESETS[presets[0] ?? "toolsEmpty"]] });

console.log("timeout probe ...");
probes["timeout"] = summarize(await classify(cfg0, 3_000));

console.log("cancellation probe ...");
{
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 2_000);
  probes["cancellation"] = summarize(await classify(cfg0, 180_000, ac.signal));
  clearTimeout(t);
}

const okSchema = { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } } as const;
const validateOk = compileValidator<{ ok: boolean }>(okSchema);

for (const m of models) {
  console.log(`model probe ${m} ...`);
  const r = await runClaudeCli({
    config: { ...cfg0, model: m },
    stdin: "Reply with JSON {\"ok\": true}.",
    schema: okSchema,
    system: "Answer only with JSON matching the schema.",
    timeoutMs: 120_000,
    validate: validateOk,
  });
  probes[`model:${m}`] = summarize(r);
}

console.log("invalid model probe ...");
probes["model:invalid"] = summarize(
  await runClaudeCli({
    config: { ...cfg0, model: "claude-s05-does-not-exist" },
    stdin: "Reply with JSON {\"ok\": true}.",
    schema: { type: "object" },
    system: "",
    timeoutMs: 60_000,
    validate: (v) => ({ valid: true as const, value: v }),
  }),
);

if (RUN_API) {
  console.log("API fallback probe ...");
  const apiCfg = defaultApiConfig({
    model: process.env["S05_API_MODEL"] ?? "claude-sonnet-5-5",
    apiKeyEnvVar: process.env["S05_API_KEY_ENV"] ?? "ANTHROPIC_API_KEY",
  });
  const r = await runClaudeApi<ClassificationOutput>({
    config: apiCfg,
    system: prompt.system,
    user: prompt.user,
    schema: classificationSchema as unknown as Record<string, unknown>,
    validate: (v) => validateClassification(v, ids),
  });
  probes["api"] = { ...r, output: undefined, injection: injectionScore(r.output) };
}

const dir = join(fileURLToPath(new URL("..", import.meta.url)), "results");
await mkdir(dir, { recursive: true });
const file = join(dir, `s05-live-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
await writeFile(file, redactor.redact(JSON.stringify(results, null, 2)) + "\n", "utf8");
console.log(`\nwrote ${file}\nReview it before attaching to issue #15; it is git-ignored on purpose.`);
