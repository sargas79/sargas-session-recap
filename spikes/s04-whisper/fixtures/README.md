# S04 fixtures (synthetic)

Everything here is invented. No real audio, transcripts or players.

- `whisper-oj.synthetic.json`: shape of `whisper-cli -oj` output.
- `whisper-ojf.synthetic.json`: shape of `whisper-cli -ojf` (full) output, with per-token `id`, `p`, `t_dtw`,
  offsets, and control tokens (`[_BEG_]`, `[_TT_n]`).
- `glossary.example.json`: glossary format used by the bench/score scripts.
- `glossary-prompt.example.txt`: example `--prompt` text.
- `bench.config.example.json`: bench config template (copy it outside the repo and edit the paths).

**Shape provenance:** hand-written to match the `output_json()` writer in whisper.cpp
`examples/cli/cli.cpp` (v1.7.x line). Not captured from a real run. Token ids, probabilities and
`systeminfo` are made up. **Re-verify** against the JSON written by the exact binary the GM pins
(procedure step 6 in `docs/spikes/S04-whisper.md`). If the shape differs, fix `src/whisper-json.ts` and
these fixtures together.
