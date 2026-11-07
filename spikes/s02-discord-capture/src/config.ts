/**
 * Harness config + opt-in allowlist (THROWAWAY spike).
 *
 * The bot token is NOT part of the config file. It is read from the environment variable
 * S02_DISCORD_TOKEN only (see readToken), is never logged, and is never written to the manifest.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const TOKEN_ENV = "S02_DISCORD_TOKEN";

export interface OptInEntry {
  user_id: string;
  /** Short pseudonymous label used in file names (e.g. "p1"). */
  label: string;
}

export interface HarnessConfig {
  application_id: string;
  guild_id: string;
  /** Only this user may run /spike start|stop|mark. */
  gm_user_id: string;
  voice_channel_id: string;
  output_root: string;
  allowlist: OptInEntry[];
  silence_close_ms: number;
  gap_fill_threshold_ms: number;
  latency_compensation_ms: number;
  max_fragment_ms: number;
  flush_interval_ms: number;
  mark_beep: boolean;
  dave_decryption_failure_tolerance: number;
}

export const DEFAULTS = {
  silence_close_ms: 1000,
  gap_fill_threshold_ms: 100,
  latency_compensation_ms: 0,
  max_fragment_ms: 30_000,
  flush_interval_ms: 1000,
  mark_beep: true,
  // @discordjs/voice 0.19.2 default; raise in the live run only if decrypt-failure resets are observed.
  dave_decryption_failure_tolerance: 24,
} as const;

const SNOWFLAKE = /^\d{17,20}$/;
const LABEL = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export class Allowlist {
  private readonly byId: Map<string, OptInEntry>;
  constructor(entries: readonly OptInEntry[]) {
    this.byId = new Map(entries.map((e) => [e.user_id, e]));
  }
  isOptedIn(userId: string): boolean {
    return this.byId.has(userId);
  }
  labelOf(userId: string): string | undefined {
    return this.byId.get(userId)?.label;
  }
  get size(): number {
    return this.byId.size;
  }
  labels(): string[] {
    return [...this.byId.values()].map((e) => e.label);
  }
}

function findRepoRoot(start: string): string | null {
  let dir = path.resolve(start);
  // Walk up from the nearest existing ancestor (output_root usually does not exist yet).
  while (!fs.existsSync(dir)) {
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Harness package directory; the checkout is located from here, never from the config file location. */
const HARNESS_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * Git working trees that output_root must not fall inside: the checkout that contains the output path
 * itself (catches any repository), plus the checkouts containing the harness module and the probe dir
 * (default: cwd). The config file's directory is deliberately not used: a config stored outside the
 * checkout must not disable the safeguard.
 */
function forbiddenRoots(out: string, probeDir: string): string[] {
  const roots = [findRepoRoot(out), findRepoRoot(HARNESS_DIR), findRepoRoot(probeDir)];
  return [...new Set(roots.filter((r): r is string => r !== null))];
}

function isInside(p: string, root: string): boolean {
  const rel = path.relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Only the numeric session parameters; this is what goes into `session_start.params`. */
export function sessionParamsOf(cfg: HarnessConfig): {
  silence_close_ms: number;
  gap_fill_threshold_ms: number;
  latency_compensation_ms: number;
  max_fragment_ms: number;
  flush_interval_ms: number;
} {
  return {
    silence_close_ms: cfg.silence_close_ms,
    gap_fill_threshold_ms: cfg.gap_fill_threshold_ms,
    latency_compensation_ms: cfg.latency_compensation_ms,
    max_fragment_ms: cfg.max_fragment_ms,
    flush_interval_ms: cfg.flush_interval_ms,
  };
}

export function validateConfig(raw: unknown, opts: { repoProbeDir?: string } = {}): HarnessConfig {
  if (typeof raw !== "object" || raw === null) throw new Error("config must be an object");
  const r = raw as Record<string, unknown>;
  const errors: string[] = [];
  for (const k of ["application_id", "guild_id", "gm_user_id", "voice_channel_id"] as const) {
    if (typeof r[k] !== "string" || !SNOWFLAKE.test(r[k] as string)) errors.push(`${k} must be a Discord snowflake string`);
  }
  if (typeof r.output_root !== "string" || r.output_root === "") errors.push("output_root is required");
  const allow = r.allowlist;
  if (!Array.isArray(allow) || allow.length === 0) errors.push("allowlist must list at least one opted-in user");
  const seenIds = new Set<string>();
  const seenLabels = new Set<string>();
  for (const [i, e] of (Array.isArray(allow) ? allow : []).entries()) {
    const ent = e as Partial<OptInEntry>;
    if (typeof ent.user_id !== "string" || !SNOWFLAKE.test(ent.user_id)) errors.push(`allowlist[${i}].user_id invalid`);
    if (typeof ent.label !== "string" || !LABEL.test(ent.label)) errors.push(`allowlist[${i}].label must match ${LABEL}`);
    if (ent.user_id && seenIds.has(ent.user_id)) errors.push(`allowlist[${i}] duplicate user_id`);
    if (ent.label && seenLabels.has(ent.label)) errors.push(`allowlist[${i}] duplicate label`);
    if (ent.user_id) seenIds.add(ent.user_id);
    if (ent.label) seenLabels.add(ent.label);
  }
  if ("token" in r || "bot_token" in r) errors.push("the token must not be in the config file; use the env var " + TOKEN_ENV);
  const cfg = { ...DEFAULTS, ...r } as HarnessConfig;
  for (const k of ["silence_close_ms", "gap_fill_threshold_ms", "latency_compensation_ms", "max_fragment_ms", "flush_interval_ms"] as const) {
    if (!Number.isInteger(cfg[k]) || cfg[k] < 0) errors.push(`${k} must be a non-negative integer`);
  }
  if (typeof cfg.output_root === "string" && cfg.output_root !== "") {
    const out = path.resolve(cfg.output_root);
    for (const root of forbiddenRoots(out, opts.repoProbeDir ?? process.cwd())) {
      if (isInside(out, root)) {
        errors.push(`output_root must be outside the git repository (${root}); recordings must never be committed`);
        break;
      }
    }
  }
  if (errors.length) throw new Error("invalid S02 config:\n  - " + errors.join("\n  - "));
  return cfg;
}

export function loadConfig(file: string): HarnessConfig {
  return validateConfig(JSON.parse(fs.readFileSync(file, "utf8")));
}

/** Reads the token from the environment only. Never log the return value. */
export function readToken(env: NodeJS.ProcessEnv = process.env): string {
  const t = env[TOKEN_ENV];
  if (!t || t.trim() === "") throw new Error(`set ${TOKEN_ENV} in the environment (see docs/spikes/S02-discord-capture.md)`);
  return t.trim();
}
