// The API harness is never exercised against the network in tests. This only
// checks that it refuses to run (and never constructs a client) without a key.
import { describe, expect, it } from "vitest";
import { defaultApiConfig, interpretApiResponse, runClaudeApi } from "../src/api-harness.js";
import { REDACTED, Redactor } from "../src/redact.js";
import { validateClassification } from "../src/schema.js";

describe("runClaudeApi (offline)", () => {
  it("returns no_key when the configured env var is unset, without falling back to other credentials", async () => {
    const r = await runClaudeApi({
      config: defaultApiConfig({ apiKeyEnvVar: "S05_TEST_KEY_THAT_IS_NOT_SET" }),
      system: "s",
      user: "u",
      schema: {},
      validate: (v) => validateClassification(v),
      env: { ANTHROPIC_AUTH_TOKEN: "would-be-used-by-default-sdk-resolution" },
    });
    expect(r.status).toBe("no_key");
  });

  it("defaults to an explicit model id from config", () => {
    expect(defaultApiConfig().model).toBe("claude-sonnet-5-5");
    expect(defaultApiConfig({ model: "x" }).model).toBe("x");
  });
});

describe("interpretApiResponse (offline, no client)", () => {
  // Opaque, unprefixed synthetic value: only the request-local redactor knows it.
  const KEY = "custom-env-opaque-key-0123456789abcdef";
  const redactor = new Redactor([KEY]);
  const msg = (text: string, stop_reason: string | null = "end_turn") => ({
    model: "claude-sonnet-5-5",
    stop_reason,
    usage: { input_tokens: 1, output_tokens: 2 },
    content: [{ type: "text", text }],
  });

  it("redacts a key echoed inside successful output", () => {
    const out = { segments: [{ id: "a", label: "in_character", injection_suspected: false }], note: `echo ${KEY}` };
    const r = interpretApiResponse({
      message: msg(JSON.stringify(out)),
      requestId: "req_1",
      validate: (v) => ({ valid: true as const, value: v as typeof out }),
      redactor,
      durationMs: 5,
    });
    expect(r.status).toBe("ok");
    expect(JSON.stringify(r)).not.toContain(KEY);
    expect(r.output?.note).toBe(`echo ${REDACTED}`);
    expect(r.usage).toEqual({ input_tokens: 1, output_tokens: 2 });
  });

  it("redacts a key echoed inside validation errors", () => {
    const r = interpretApiResponse({
      message: msg(JSON.stringify({ segments: [{ id: KEY, label: "gm_narration", injection_suspected: false }] })),
      requestId: null,
      validate: (v) => validateClassification(v, ["a"]),
      redactor,
      durationMs: 5,
    });
    expect(r.status).toBe("schema_invalid");
    expect(r.validationErrors).toContain(`unknown segment id: ${REDACTED}`);
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it("maps refusal / max_tokens / non-JSON stop states", () => {
    const base = { requestId: null, validate: (v: unknown) => ({ valid: true as const, value: v }), redactor, durationMs: 0 };
    expect(interpretApiResponse({ ...base, message: msg("", "refusal") }).status).toBe("refusal");
    expect(interpretApiResponse({ ...base, message: msg("", "max_tokens") }).status).toBe("max_tokens");
    expect(interpretApiResponse({ ...base, message: msg(`not json ${KEY}`) })).toMatchObject({ status: "non_json" });
    expect(JSON.stringify(interpretApiResponse({ ...base, message: msg(`not json ${KEY}`) }))).not.toContain(KEY);
  });
});
