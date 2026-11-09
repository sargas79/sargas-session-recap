// Fake `claude` executable for the classify stage. Never contacts anything. It answers from the
// segments it finds in the prompt, so the stage's windows and validation are exercised for real.
//
// FAKE_CLASSIFY_CONTROL  JSON file: { "log": <file>, "windows": { "<first ref>": [modes...] } }
//   modes apply per attempt at that window; the last one repeats; a window not listed is `ok`.
//   ok | missing | duplicate | unknown | context | non-json | not-logged-in | bad-schema
//
// Labels and corrections come from words in the synthetic segment text:
//   OOC MIXED UNSURE NARR RULE, Kira -> Kyra, Sara Ray -> Sarenrae, Zebulon (unmatched), SPOIL
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const control = JSON.parse(readFileSync(process.env.FAKE_CLASSIFY_CONTROL, 'utf8'));
const stateFile = `${process.env.FAKE_CLASSIFY_CONTROL}.state`;

function slot(prompt, name) {
  const match = new RegExp(
    `<untrusted-data-[0-9a-f]+ name="${name}">\\n([\\s\\S]*?)</untrusted-data-`,
  ).exec(prompt);
  if (match === null) throw new Error(`no slot ${name}`);
  return match[1]
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line));
}

function nextMode(first) {
  const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};
  const attempt = state[first] ?? 0;
  state[first] = attempt + 1;
  writeFileSync(stateFile, JSON.stringify(state));
  const modes = control.windows?.[first] ?? ['ok'];
  return modes[Math.min(attempt, modes.length - 1)];
}

function labelOf(text) {
  for (const [word, label] of [
    ['OOC', 'ooc'],
    ['MIXED', 'mixed'],
    ['UNSURE', 'uncertain'],
    ['NARR', 'narration'],
    ['RULE', 'rules'],
  ]) {
    if (text.includes(word)) return label;
  }
  return 'ic';
}

function correctionsOf(text) {
  const corrections = [];
  if (text.includes('Kira')) {
    corrections.push({ kind: 'name', from: 'Kira', to: 'Kyra', glossary_id: 'kyra' });
  }
  if (text.includes('Sara Ray')) {
    corrections.push({ kind: 'term', from: 'Sara Ray', to: 'Sarenrae', glossary_id: 'sarenrae' });
  }
  if (text.includes('Bogus')) {
    corrections.push({ kind: 'name', from: 'Bogus', to: 'Kyra', glossary_id: 'no-such-entry' });
  }
  if (text.includes('Phantom')) {
    corrections.push({ kind: 'spelling', from: 'not-in-this-text', to: 'x' });
  }
  return corrections;
}

function resultFor(segment) {
  return {
    segment_ref: segment.ref,
    label: labelOf(segment.text),
    corrections: correctionsOf(segment.text),
    unmatched_names: segment.text.includes('Zebulon') ? ['Zebulon', 'Nowhere In Text'] : [],
    possible_spoiler: segment.text.includes('SPOIL'),
  };
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

function main(prompt) {
  const segments = slot(prompt, 'segments');
  const before = slot(prompt, 'context_before');
  const after = slot(prompt, 'context_after');
  const first = segments[0].ref;
  const mode = nextMode(first);
  appendFileSync(
    control.log,
    `${JSON.stringify({ first, mode, refs: segments.map((s) => s.ref), before: before.map((s) => s.ref), after: after.map((s) => s.ref), prompt })}\n`,
  );
  let results = segments.map(resultFor);
  switch (mode) {
    case 'missing':
      results = results.slice(0, -1);
      break;
    case 'duplicate':
      results = [...results, results[0]];
      break;
    case 'unknown':
      results = [...results, { ...results[0], segment_ref: '99999:0' }];
      break;
    case 'context': {
      const neighbour = before[0] ?? after[0];
      results = [...results, { ...results[0], segment_ref: neighbour.ref }];
      break;
    }
    case 'bad-schema':
      process.stdout.write(envelope({ structured_output: { schema_version: 1, results: [{}] } }));
      return;
    case 'non-json':
      process.stdout.write('not json\n');
      return;
    case 'not-logged-in':
      process.stdout.write(
        envelope({
          is_error: true,
          result: 'Not logged in',
          usage: { input_tokens: 0, output_tokens: 0 },
        }),
      );
      process.exitCode = 1;
      return;
    default:
      break;
  }
  process.stdout.write(envelope({ structured_output: { schema_version: 1, results } }));
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  main(input);
});
