// Fake `claude` executable for the LLM adapter tests. It never contacts anything.
//
// FAKE_CLAUDE_MODES    comma-separated modes, one per invocation (the last one repeats)
// FAKE_CLAUDE_COUNTER  file holding the invocation count
// FAKE_CLAUDE_RECORD   file that receives argv, cwd, stdin and env names
// FAKE_CLAUDE_OUTPUT   JSON printed as structured_output in the `valid` mode
// FAKE_CLAUDE_PID_FILE file that receives a grandchild's pid in the `hang-tree` mode
/* global setInterval */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const env = process.env;

function nextMode() {
  const modes = (env.FAKE_CLAUDE_MODES ?? 'valid').split(',');
  const file = env.FAKE_CLAUDE_COUNTER;
  if (file === undefined) return modes[0];
  const count = existsSync(file) ? Number(readFileSync(file, 'utf8')) : 0;
  writeFileSync(file, String(count + 1));
  return modes[Math.min(count, modes.length - 1)];
}

function envelope(extra) {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 2,
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      cache_creation_input_tokens: 30,
      cache_read_input_tokens: 40,
    },
    ...extra,
  });
}

const NO_USAGE = { usage: { input_tokens: 0, output_tokens: 0 } };

function hangForever() {
  setInterval(() => undefined, 1000);
}

function main(stdin) {
  if (env.FAKE_CLAUDE_RECORD !== undefined) {
    writeFileSync(
      env.FAKE_CLAUDE_RECORD,
      JSON.stringify({
        args: process.argv.slice(2),
        cwd: process.cwd(),
        stdin,
        envNames: Object.keys(env),
      }),
    );
  }
  switch (nextMode()) {
    case 'valid':
      process.stdout.write(
        envelope({ structured_output: JSON.parse(env.FAKE_CLAUDE_OUTPUT ?? '{}') }),
      );
      return;
    case 'schema-invalid':
      process.stdout.write(envelope({ structured_output: { results: [{ label: 'banana' }] } }));
      return;
    case 'no-structured-output':
      process.stdout.write(envelope({ result: 'Sure, here is the JSON you asked for.' }));
      return;
    case 'non-json':
      process.stdout.write('this is not JSON\n');
      return;
    case 'is-error':
      process.stdout.write(envelope({ is_error: true, result: 'boom' }));
      process.stderr.write('something failed\n');
      process.exitCode = 1;
      return;
    case 'not-logged-in':
      process.stdout.write(envelope({ is_error: true, result: 'Not logged in', ...NO_USAGE }));
      process.exitCode = 1;
      return;
    case 'invalid-model':
      process.stdout.write(envelope({ is_error: true, result: 'bad model', ...NO_USAGE }));
      process.stderr.write('[claude-code:unrecognized_model] no such model\n');
      process.exitCode = 1;
      return;
    case 'exit-with-secret':
      process.stderr.write('fatal: key=sk-ant-api03-FAKEFAKEFAKEFAKEFAKE1234 and more\n');
      process.exitCode = 3;
      return;
    case 'write-cwd':
      writeFileSync('CANARY', 'a tool ran');
      process.stdout.write(envelope({ structured_output: {} }));
      return;
    case 'huge':
      process.stdout.write('x'.repeat(2 * 1024 * 1024));
      return;
    case 'hang-tree': {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], {
        stdio: 'ignore',
      });
      writeFileSync(env.FAKE_CLAUDE_PID_FILE, String(child.pid));
      hangForever();
      return;
    }
    default:
      process.stderr.write('unknown fake mode\n');
      process.exitCode = 2;
  }
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  main(input);
});
