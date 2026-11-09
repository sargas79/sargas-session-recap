// Fake `claude` executable for the recap stage. Never contacts anything. It answers from a script.
//
// FAKE_RECAP_CONTROL  JSON file: { "log": <file>, "outputs": [<structured output>...] }
//   One output per attempt; the last one repeats. "not-logged-in" as an output fails the call.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const control = JSON.parse(readFileSync(process.env.FAKE_RECAP_CONTROL, 'utf8'));
const stateFile = `${process.env.FAKE_RECAP_CONTROL}.state`;

function nextOutput() {
  const attempt = existsSync(stateFile) ? Number(readFileSync(stateFile, 'utf8')) : 0;
  writeFileSync(stateFile, String(attempt + 1));
  return control.outputs[Math.min(attempt, control.outputs.length - 1)];
}

function envelope(extra) {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 2,
    usage: { input_tokens: 100, output_tokens: 10 },
    ...extra,
  });
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  appendFileSync(control.log, `${JSON.stringify({ prompt: input })}\n`);
  const output = nextOutput();
  if (output === 'not-logged-in') {
    process.stdout.write(
      envelope({
        is_error: true,
        result: 'Not logged in',
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(envelope({ structured_output: output }));
});
