import { describe, expect, it } from "vitest";
import { REDACTED, Redactor, createSafeLogger } from "../src/redact.js";

// Obviously fake, synthetic values. Never real keys.
const KEY = "sk-ant-api03-ZZZZfakefakefakefakefakefakefake_-0123456789";
const TOKEN = "unprefixed-oauth-token-value-9f8e7d6c";

describe("Redactor", () => {
  const r = new Redactor([KEY, TOKEN]);

  it("masks registered secrets", () => {
    expect(r.redact(`key=${KEY} tok=${TOKEN}`)).toBe(`key=${REDACTED} tok=${REDACTED}`);
  });

  it("masks encoded variants (URL, base64, base64url)", () => {
    const text = [encodeURIComponent(TOKEN + "/x"), Buffer.from(KEY).toString("base64"), Buffer.from(KEY).toString("base64url")].join(" ");
    const out = r.redact(text);
    expect(out).not.toContain(Buffer.from(KEY).toString("base64"));
    expect(out).not.toContain(Buffer.from(KEY).toString("base64url"));
    expect(out).not.toContain(TOKEN);
  });

  it("masks unregistered Anthropic-looking keys and bearer tokens by pattern", () => {
    const fresh = new Redactor();
    const out = fresh.redact(
      `x-api-key: sk-ant-admin01-QQQQQQQQQQQQQQQQ Authorization: Bearer abc.def.ghijklmnopqrstu "x-api-key":"opaque-value-123456"`,
    );
    expect(out).not.toContain("QQQQQQQQ");
    expect(out).not.toContain("ghijklmnop");
    expect(out).not.toContain("opaque-value-123456");
    expect(out).toContain("Bearer [REDACTED]");
  });

  it("x-api-key pattern keeps JSON escapes intact so redactValue never produces invalid JSON", () => {
    const fresh = new Redactor();
    const v = fresh.redactValue({ msg: 'x-api-key=opaque-synthetic-123456" trailing message' });
    expect(v.msg).toBe(`x-api-key=${REDACTED}" trailing message`);
    // Double-serialized header (escaped quotes) is still masked and stays valid JSON.
    const nested = fresh.redactValue({ body: JSON.stringify({ "x-api-key": "opaque-synthetic-abcdef" }) });
    expect(nested.body).not.toContain("opaque-synthetic-abcdef");
    expect(JSON.parse(nested.body)).toEqual({ "x-api-key": REDACTED });
  });

  it("reads secrets from known env vars", () => {
    const er = new Redactor().addFromEnv({ ANTHROPIC_API_KEY: TOKEN });
    expect(er.redact(TOKEN)).toBe(REDACTED);
  });

  it("ignores very short values (would over-redact)", () => {
    expect(new Redactor(["abc"]).redact("abcabc")).toBe("abcabc");
  });

  it("redacts errors: message, stack and cause, without returning the original object", () => {
    const original = new Error(`401 invalid x-api-key ${KEY}`, { cause: new Error(`header ${TOKEN}`) });
    const safe = r.redactError(original);
    expect(safe).not.toBe(original);
    expect(safe.message).not.toContain(KEY);
    expect(safe.stack ?? "").not.toContain(KEY);
    expect(String(safe.cause)).not.toContain(TOKEN);
    expect(r.redactError(`string ${KEY}`).message).not.toContain(KEY);
  });

  it("deep-redacts JSON values", () => {
    const v = r.redactValue({ a: [{ b: `x${KEY}y` }], n: 1 });
    expect(JSON.stringify(v)).not.toContain(KEY);
    expect(v.n).toBe(1);
  });

  it("safe logger never writes secrets, even in structured fields", () => {
    const lines: string[] = [];
    const log = createSafeLogger(r, (l) => lines.push(l));
    log.error("request failed", { headers: { "x-api-key": KEY }, err: `boom ${TOKEN}` });
    expect(lines.join("\n")).not.toContain(KEY);
    expect(lines.join("\n")).not.toContain(TOKEN);
    expect(lines[0]).toContain(REDACTED);
  });
});
