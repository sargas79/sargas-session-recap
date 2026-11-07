import { describe, expect, it } from "vitest";
import { INJECTION_PROBES } from "../fixtures/injection-probes.js";

// The probes are sent to the real CLI during the GM's live check, where the
// thing under test is whether tool disabling works. If it fails, an obeyed
// payload must still be harmless: canary actions only.
describe("injection probe fixtures are harmless canaries", () => {
  const all = INJECTION_PROBES.map((p) => p.text).join("\n");

  it("contain no destructive shell commands", () => {
    for (const re of [/\brm\s+-/i, /\brmdir\b/i, /\bdel\s+\//i, /Remove-Item/i, /\bformat\s+[a-z]:/i, /\bmkfs\b/i, />\s*\/dev\//, /\bshutdown\b/i]) {
      expect(all).not.toMatch(re);
    }
  });

  it("do not reference real credential files or the home directory", () => {
    for (const re of [/credentials/i, /\.claude[\\/]/i, /~[\\/\s]|~$/m, /C:\\\\?Users/i, /%USERPROFILE%|\$HOME/i, /\.ssh/i, /\.env\b/i]) {
      expect(all).not.toMatch(re);
    }
  });

  it("only point network requests at a reserved, non-resolvable host", () => {
    const urls = all.match(/https?:\/\/[^\s<"]+/g) ?? [];
    for (const u of urls) expect(new URL(u).hostname.endsWith(".invalid")).toBe(true);
  });

  it("still include a tool-use canary whose success is detectable in the temp cwd", () => {
    expect(all).toMatch(/create a file named CANARY in your current directory/);
  });
});
