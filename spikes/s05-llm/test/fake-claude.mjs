#!/usr/bin/env node
// Fake `claude` executable used by the unit tests. It never contacts anything.
// Behaviour is selected by the FAKE_CLAUDE_MODE env var. When FAKE_CLAUDE_RECORD
// is set, argv/cwd/stdin/env-keys are written to that file for assertions.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const mode = process.env.FAKE_CLAUDE_MODE ?? "valid";
const args = process.argv.slice(2);

if (args.includes("--version")) {
  process.stdout.write("9.9.9-fake (Claude Code)\n");
  process.exit(0);
}

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (stdin += d));
process.stdin.on("end", main);

function ids() {
  return [...stdin.matchAll(/"id":"([^"]+)"/g)].map((m) => m[1]);
}

function envelope(extra) {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 1234,
    duration_api_ms: 1000,
    num_turns: 1,
    session_id: "fake-session",
    total_cost_usd: 0.0123,
    usage: {
      input_tokens: 321,
      output_tokens: 45,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 0,
      service_tier: "standard",
    },
    modelUsage: { "claude-sonnet-5-5": { inputTokens: 321, outputTokens: 45 } },
    ...extra,
  });
}

function main() {
  if (process.env.FAKE_CLAUDE_RECORD) {
    writeFileSync(
      process.env.FAKE_CLAUDE_RECORD,
      JSON.stringify({ args, cwd: process.cwd(), stdin, envKeys: Object.keys(process.env).sort() }),
    );
  }
  const valid = { segments: ids().map((id) => ({ id, label: "in_character", injection_suspected: false })) };
  switch (mode) {
    case "valid":
      process.stdout.write(envelope({ result: JSON.stringify(valid), structured_output: valid }));
      process.exit(0);
    case "valid-result-only":
      process.stdout.write(envelope({ result: JSON.stringify(valid) }));
      process.exit(0);
    case "schema-invalid":
      process.stdout.write(
        envelope({ structured_output: { segments: [{ id: "p-001", label: "banana", injection_suspected: "yes" }] } }),
      );
      process.exit(0);
    case "unknown-id": {
      const bad = { segments: [...valid.segments, { id: "forged-999", label: "gm_narration", injection_suspected: false }] };
      process.stdout.write(envelope({ structured_output: bad }));
      process.exit(0);
    }
    case "prose-result":
      process.stdout.write(envelope({ result: "Sure! Here is the classification: ```json {} ```" }));
      process.exit(0);
    case "non-json":
      process.stdout.write("Error: something went wrong, this is not JSON\n");
      process.exit(0);
    case "cli-error":
      process.stdout.write(envelope({ subtype: "error_during_execution", is_error: true, result: "boom" }));
      process.exit(1);
    case "exit-nonzero":
      process.stderr.write("fatal: auth required. key=sk-ant-api03-FAKEFAKEFAKEFAKEFAKE1234\n");
      process.exit(3);
    case "write-cwd":
      writeFileSync("pwned.txt", "tool wrote here");
      process.stdout.write(envelope({ structured_output: valid }));
      process.exit(0);
    case "hang":
      setInterval(() => {}, 1000);
      break;
    case "hang-with-child": {
      // Grandchild that also hangs; its pid is reported so the test can check the tree kill.
      const gc = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
      if (process.env.FAKE_CLAUDE_CHILD_PID_FILE) writeFileSync(process.env.FAKE_CLAUDE_CHILD_PID_FILE, String(gc.pid));
      setInterval(() => {}, 1000);
      break;
    }
    case "huge":
      process.stdout.write("x".repeat(2 * 1024 * 1024));
      process.exit(0);
    default:
      process.stderr.write(`unknown FAKE_CLAUDE_MODE ${mode}\n`);
      process.exit(2);
  }
}
