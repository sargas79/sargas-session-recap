/**
 * Stand-in for whisper-cli in tests. No GPU, no model, no network; everything it writes is
 * synthetic. Started as `node fake-whisper.mjs <control.json> <whisper args...>`.
 *
 * Every call is appended to `control.log`. `control.chunks[<n>]` scripts chunk <n>:
 * - `failTimes`: exit 3 that many times, then behave normally;
 * - `hang`: never exit;
 * - `killParent`: write a partial output and kill the process that started it (a crash);
 * - `corruptFile`: write to that path (to prove the audio is checked after the run);
 * - `raw`: the exact text of the output file;
 * - `segments`: the `transcription` array (default: one good segment).
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { setInterval } from 'node:timers';

const [, , controlPath, ...commandLine] = process.argv;
// `@file`: one argument per line, as whisper-cli reads it.
const viaResponseFile = commandLine.length === 1 && commandLine[0].startsWith('@');
const args = viaResponseFile
  ? readFileSync(commandLine[0].slice(1), 'utf8').split(/\r?\n/).slice(0, -1)
  : commandLine;
const control = JSON.parse(readFileSync(controlPath, 'utf8'));
const opt = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};

const wav = opt('-f');
const base = opt('-of');
const chunk = Number(/chunk-(\d+)\.wav$/.exec(wav)[1]);
const script = control.chunks?.[String(chunk)] ?? {};

appendFileSync(
  control.log,
  `${JSON.stringify({
    chunk,
    model: opt('-m'),
    language: opt('-l'),
    prompt: opt('--prompt') ?? null,
    full: args.includes('-ojf'),
    viaResponseFile,
    wavBytes: readFileSync(wav).length,
  })}\n`,
);

if (script.corruptFile !== undefined) writeFileSync(script.corruptFile, 'overwritten');

if (script.failTimes !== undefined) {
  const counter = `${control.log}.fails-${String(chunk)}`;
  const used = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0;
  if (used < script.failTimes) {
    writeFileSync(counter, String(used + 1));
    process.exit(3);
  }
}

if (script.hang === true) {
  setInterval(() => undefined, 1000);
} else if (script.killParent === true) {
  writeFileSync(`${base}.json`, '{"transcription": [');
  process.kill(process.ppid, 'SIGKILL');
  process.exit(1);
} else {
  const output =
    script.raw ??
    JSON.stringify({
      // Differs on every call, like the real field (S04 section 5.2).
      systeminfo: `fake ${String(process.hrtime.bigint())}`,
      model: { type: 'fake' },
      params: { model: opt('-m'), language: opt('-l'), translate: false },
      result: { language: opt('-l') },
      transcription: script.segments ?? [
        {
          timestamps: { from: '00:00:00,000', to: '00:00:01,500' },
          offsets: { from: 0, to: 1500 },
          text: ` fala sintetica ${String(chunk)}`,
          tokens: [
            { text: '[_BEG_]', p: 0.01, id: 1, t_dtw: -1 },
            { text: ' fala', p: 0.92, id: 2, t_dtw: -1 },
            { text: ' sintetica', p: 0.88, id: 3, t_dtw: -1 },
          ],
        },
      ],
    });
  writeFileSync(`${base}.json`, output);
}
