// The API harness is never exercised against the network in tests. This only
// checks that it refuses to run (and never constructs a client) without a key.
import { describe, expect, it } from "vitest";
import { defaultApiConfig, runClaudeApi } from "../src/api-harness.js";
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
