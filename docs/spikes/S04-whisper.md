# S04: whisper.cpp Vulkan on Windows, Portuguese/English benchmark

- Issue: #14 (`S04`, parent #2 `F00`, roadmap #1)
- Pickup: agent-assisted. The agent wrote the harness in `spikes/s04-whisper/`. The GM runs it on the RX 9070 XT PC
  and hand-checks accuracy. Every number in this document must come from a recorded run. Blank cells stay blank
  until then.
- Blocks: #17 `G01`, #26 `T08`, #47 `T23`

**Outcome: PENDING (human run required)**

## 1. Question

Does whisper.cpp with the Vulkan backend run reliably on the Windows PC (AMD RX 9070 XT)? For Portuguese speech
with English game terms and names, which model is better: `large-v3-turbo` or `large-v3`? What timestamp and
confidence data does whisper.cpp actually give us, and how much of it is usable for `low_confidence`, chunking and
resumability?

## 2. Timebox

2 days of GM time, including model downloads, the hand-checked reference transcript and the runs. If Vulkan is not
working by the end of day 1, record what happened and set the outcome to FAIL or UNRESOLVED. Do not keep debugging
drivers past the timebox.

## 3. Harness (what the agent built)

All under `spikes/s04-whisper/` (Node 24, TypeScript run directly by Node, Vitest). Nothing in it downloads
anything. Every external program is started with an argument array and no shell.

| Script | Purpose |
|---|---|
| `npm run bench -- --config <cfg.json> [--dry-run] [--no-hash] [--driver "..."] [--whisper-version "..."]` | Runs models × audio × prompt (none/glossary) × VAD (off/whisper-vad) × optional CPU baseline × repeats. Records wall time, RTF, exit code, output paths, sha256 of binary/models/audio/outputs/prompt, Vulkan lines from stderr, `whisper_print_timings`, PROVISIONAL confidence summary and, when a reference transcript is given, WER/CER/term accuracy. Writes `<outDir>/results.json` and `results.md`. `--dry-run` only prints the commands. |
| `npm run parse -- <out.json> [--text]` | Parses one whisper.cpp JSON file (`-oj` or `-ojf`) and prints segments (integer ms), token counts and per-segment PROVISIONAL confidence. Prints text only with `--text`. |
| `npm run score -- --ref ref.txt --hyp out.json [--glossary g.json] [--strip-diacritics]` | WER and CER (S/D/I breakdown) plus count-based term/name accuracy. |
| `npm run drift -- --whisper ... --model ... --input long.wav --out <dir> [--chunk-sec 20,25,30] [--mode fixed\|pause] [--overlap-ms N] [--dry-run]` | Chunk-boundary and timestamp drift probe. Needs ffmpeg. |
| `npm run silence -- --input long.wav [--noise-db -35] [--min-silence-ms 500] [--target-ms 25000] [--max-ms 30000]` | ffmpeg `silencedetect` plus a pause-split chunk plan. Outputs timings only. Needs ffmpeg. |

Safety rails: the bench and drift scripts refuse an output directory inside a git checkout, except the git-ignored
`spikes/s04-whisper/results/`. The spike `.gitignore` also excludes audio and model files. Results contain
transcripts, so keep them in a private folder such as `D:\s04-private\`.

Normalisation used for scores: lower-case, punctuation removed (intra-word `-` and `'` kept), diacritics **kept** by
default. The bench also reports a WER with diacritics stripped. CER is computed over normalised characters,
spaces included. Term accuracy is count-based (per term: min(ref count, hyp count) / ref count). It is not
alignment-based, so it can over-credit a term that shows up in the wrong place.

JSON shape: the parser and the synthetic fixtures (`spikes/s04-whisper/fixtures/`) were written against the
`output_json()` writer of whisper.cpp `examples/cli/cli.cpp`, v1.7.x line. **They were not captured from a real run
and must be re-verified in step 6.** The CLI flags in `src/commands.ts` (`-oj -ojf -of -l --prompt -ng -t -bs -bo
--vad -vm -vt -vspd -vsd -vp`) must also be checked against `--help` of the pinned binary.

## 4. Procedure for the GM

Keep everything private (audio, references, results, config with local paths) outside the repo, e.g. in
`D:\s04-private\{audio,reference,results}`. Use only consented samples.

### Step 0: prerequisites

1. Node 24 (`node -v`), then `cd spikes\s04-whisper; npm ci; npm test` (should be green).
2. **ffmpeg** on `PATH` (or pass `--ffmpeg <path>`). It is required for audio conversion, the drift probe and
   `silencedetect`. Record `ffmpeg -version` (first line) and where you got it. This also answers G-1 in
   `docs/implementation-plan.md`.
3. If you build whisper.cpp yourself: Git, CMake, Visual Studio 2022 Build Tools (C++ workload), the LunarG
   Vulkan SDK. Record the version of each.

### Step 1: record the environment

```powershell
Get-CimInstance Win32_VideoController | Select-Object Name, DriverVersion, DriverDate
Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber
vulkaninfo --summary   # from the Vulkan SDK; note apiVersion and driverVersion of the RX 9070 XT
```

Also note the AMD Adrenalin version from the AMD Software UI (it is not the same as the Windows `DriverVersion`).

### Step 2: get a Vulkan whisper.cpp binary

Option A: build from source (recommended, because the commit is exact):

```powershell
git clone https://github.com/ggml-org/whisper.cpp C:\tools\whisper.cpp
cd C:\tools\whisper.cpp
git checkout <tag>            # use a release tag; record it
git rev-parse HEAD            # record
cmake -B build -DGGML_VULKAN=ON
cmake --build build --config Release -j
# binary: build\bin\Release\whisper-cli.exe  (check the path; it may differ between versions)
```

Option B: a prebuilt binary. Record the exact download URL, release tag, archive sha256 and how you confirmed it
is a Vulkan build (the log line in step 3). Do not use a binary whose source you cannot name.

Record the binary sha256: `Get-FileHash -Algorithm SHA256 <whisper-cli.exe>` (the bench also records it).

### Step 3: Vulkan smoke test

```powershell
cd C:\tools\whisper.cpp
.\build\bin\Release\whisper-cli.exe --help > D:\s04-private\whisper-help.txt
.\build\bin\Release\whisper-cli.exe -m <model> -f samples\jfk.wav 2> D:\s04-private\smoke-gpu.txt
.\build\bin\Release\whisper-cli.exe -m <model> -f samples\jfk.wav -ng 2> D:\s04-private\smoke-cpu.txt
```

Check `smoke-gpu.txt` for `ggml_vulkan` lines that name the RX 9070 XT, and for whether the encoder actually ran on
the GPU. Compare `whisper_print_timings` between the GPU and CPU runs. If Vulkan is missing or crashes, record the
exact error, driver and binary, and stop at the timebox (section 2).

### Step 4: models (download manually, then hash)

From the whisper.cpp model repository on Hugging Face (`ggerganov/whisper.cpp`), or with
`models\download-ggml-model.cmd <name>` from the checkout:

- `ggml-large-v3-turbo.bin`
- `ggml-large-v3.bin`
- optional: a quantized variant (e.g. `-q5_0`) if VRAM or speed is an issue. If you test one, record it as its own model.
- optional, for the VAD comparison: the Silero VAD ggml model (e.g. `ggml-silero-v5.1.2.bin`, via
  `models\download-vad-model.cmd` if your version has it).

```powershell
Get-FileHash -Algorithm SHA256 C:\tools\whisper-models\*.bin | Format-List
```

Compare with the hash published on the Hugging Face file page, if there is one. Write the hashes in table 5.1.

### Step 5: audio, reference and glossary (all private)

1. Convert each sample to 16 kHz mono PCM WAV (the bench reads the WAV header for an exact duration):
   `ffmpeg -hide_banner -i in.m4a -ar 16000 -ac 1 -c:a pcm_s16le D:\s04-private\audio\excerpt01.wav`
2. **Excerpt** (3 to 5 min, several speakers, dense with English game terms and character names): write a
   hand-checked reference transcript `D:\s04-private\reference\excerpt01.txt` (UTF-8, plain text, verbatim, with
   canonical spellings of terms/names).
3. **Long file** (20 to 60 min) for RTF and drift. It needs no reference.
4. Glossary: `D:\s04-private\glossary.json` in the format of `spikes/s04-whisper/fixtures/glossary.example.json`
   (`kind`: `term` or `name`; `aliases` are accepted spellings), and the exact prompt text in
   `D:\s04-private\glossary-prompt.txt` (see `fixtures/glossary-prompt.example.txt`). Keep the prompt short:
   whisper keeps only about 224 tokens of prompt.

### Step 6: verify the JSON shape and flags

```powershell
whisper-cli.exe -m <turbo> -f D:\s04-private\audio\excerpt01.wav -l pt -oj -ojf -of D:\s04-private\shape-check
cd <repo>\spikes\s04-whisper
npm run parse -- D:\s04-private\shape-check.json
```

- Compare field names and nesting with `fixtures/whisper-ojf.synthetic.json`: `transcription[].offsets.{from,to}`
  in ms, `timestamps`, `text`, `tokens[].{text,id,p,t_dtw,offsets}`. Note any differences (for example new fields
  like per-segment no-speech probability). If something differs, fix `src/whisper-json.ts` and the fixtures before
  you go on.
- Check every flag in `src/commands.ts` against `whisper-help.txt` from step 3.
- **Windows prompt encoding check.** Node passes arguments to the process as UTF-16. Whether `whisper-cli`
  turns them into UTF-8 depends on its `main()`. Check the pinned source
  (`Select-String -Path examples\cli\cli.cpp -Pattern 'GetCommandLineW|CommandLineToArgvW|wmain'`). Then confirm
  it in practice: put a made-up accented name that is spoken in the excerpt (e.g. `Zéfirão`) into the prompt and
  check whether the output spells it with correct accents. Output like `Ã©` or `?` means the prompt was mangled.
  If it is mangled, record it and use an ASCII-only prompt for the benchmark.

### Step 7: benchmark

1. Copy `fixtures/bench.config.example.json` to `D:\s04-private\bench.config.json` and edit the paths.
   Use `"repeats": 2` (needed for the determinism check). Set `"includeCpuBaseline": true` on the excerpt only if
   you want a CPU reference (slow).
2. Dry run, and check the commands:
   `npm run bench -- --config D:\s04-private\bench.config.json --dry-run`
3. Real run (the driver and version are copied into the results as given; the harness never guesses them):
   `npm run bench -- --config D:\s04-private\bench.config.json --driver "Adrenalin <x.y.z> / <DriverVersion>" --whisper-version "<tag> <commit>"`
4. Keep `results.json`/`results.md` private. Copy only the **numbers** (no transcript text) into section 5.

RTF in the table is wall time (including model load) divided by audio duration. `whisper_print_timings` in
`results.json` gives the load/encode/decode split, so record both if model load dominates on short files.

### Step 8: hand-check

1. Read the transcripts of the excerpt for each model with and without the glossary prompt. Note systematic errors
   (terms, names, numbers, code-switching, crosstalk, hallucinated text in silence or music).
2. Confidence: for the turbo and large `-ojf` outputs of the excerpt, run `npm run parse -- <out.json> --text` and
   mark each segment as actually wrong or OK. Count, per model, how many segments flagged `lowConfidence: yes` were
   wrong (true positives), how many flagged ones were fine (false positives), and how many wrong segments were not
   flagged (misses). If the PROVISIONAL thresholds (`minTokenP 0.35`, `meanTokenP 0.7` in `src/confidence.ts`) are
   clearly off, try others in the parse script and record what works better.

### Step 9: chunk-boundary and drift probe

```powershell
npm run drift -- --whisper <whisper-cli.exe> --model <best model> --input D:\s04-private\audio\long01.wav --out D:\s04-private\results\drift-fixed --chunk-sec 20,25,30 --mode fixed
npm run drift -- --whisper <whisper-cli.exe> --model <best model> --input D:\s04-private\audio\long01.wav --out D:\s04-private\results\drift-pause --chunk-sec 20,25,30 --mode pause
# optional: --overlap-ms 1000 (fixed mode) and --vad-model <silero.bin>
```

Each run transcribes the whole file once as the reference timeline, then each chunk on its own, and compares them
(`drift-summary.md` plus `drift-<mode>-<sec>s.json`). It reports start/end offsets for interior vs near-boundary
segments, segments that end past their chunk, non-monotonic or zero-length segments, word differences within
±2 s of each boundary, and overall WER between the full and the chunked transcript. Spot-check a few boundaries by
ear.

### Step 10: VAD and pause-split comparison

1. `npm run silence -- --input D:\s04-private\audio\long01.wav --out D:\s04-private\results\silence-35.json` with
   `--noise-db -30`, `-35`, `-40` and `--min-silence-ms 300`, `500`, `800`. Record the number of pauses and of hard
   cuts (chunks with no pause available).
2. Compare with the bench results for `vad-off` vs `vad-whisper-vad` (WER, RTF, hallucinated text in silence) and
   with the `--mode pause` drift results.

### Step 11: record and decide

Fill in section 5 and 6, list limitations, set the outcome line at the top, and post `Outcome: PASS | FAIL |
UNRESOLVED` as the last comment on #14, with links to this document. Never commit audio, transcripts or
`results.json`.

## 5. Results (to be filled in by the GM)

### 5.0 Agent-run CPU smoke test (2026-11-08)

Run by an agent at the GM's request, on the GM's PC, before the Vulkan build and the Portuguese samples exist.
**This is not the S04 benchmark**: English public-domain sample only, CPU only, no WER.

Input: `samples/jfk.wav` from whisper.cpp v1.9.5 (11.0 s, English). Command:
`whisper-cli -m <model> -f jfk.wav -l en -ojf -t 8` (defaults: 5 beams, best of 5, flash attention on).

| Model | Device | Wall time (whisper `total time`) | Real-time factor | Segments | Mean token p | Transcript correct? |
|---|---|---|---|---|---|---|
| large-v3-turbo | CPU, 8 threads | 5.46 s | 0.50 | 1 (0.00–10.40 s) | 0.910 | yes |
| large-v3 | CPU, 8 threads | 8.70 s | 0.79 | 3 (0–3, 3–8, 8–11 s) | 0.915 | yes |

Observations:
- Both models run on this CPU build and the JSON matches the parser (§5.1).
- Turbo returned one long segment where large-v3 split at phrase boundaries. Segment length matters for review and
  chunk planning (T08); check this on the Portuguese long file.
- CPU large-v3 is close to real time (RTF 0.79, about 47 min per hour of transcribed audio) even on a 9800X3D, and
  transcription runs per speaker track. Only speech after pause removal counts, but a full session is still hours
  on CPU. The Vulkan build is what makes large-v3 practical, so step 2 is still required for the S04 decision.
- RTF here is measured on an 11 s clip, which overstates model-load overhead; use the long-file numbers (§5.3).

**Vulkan build, same clip (agent run, 2026-11-08).** whisper.cpp v1.9.5 (commit `d1be6fd`) built locally with
`-DGGML_VULKAN=ON` (CMake 4.4.4, MSVC Build Tools 17.14.44, Vulkan SDK 1.4.363.0), installed at
`%LOCALAPPDATA%\sargas-recap\tools\whisper\v1.9.5-vulkan\`. Warm runs (the first run per model compiles shaders and
takes a few seconds longer):

| Model | Device | whisper `total time` | of which load | Encode | RTF (total) | Transcript correct? |
|---|---|---|---|---|---|---|
| large-v3-turbo | Vulkan, RX 9070 XT | 1.37 s | 1.12 s | 91 ms | 0.12 | yes |
| large-v3 | Vulkan, RX 9070 XT | 2.69 s | 2.05 s | 97 ms | 0.24 | yes |

On the CPU the encode step took 4.33 s (turbo) and 4.99 s (large-v3), so Vulkan encodes about 50× faster. Total time on
this clip is dominated by model load, which is paid once per process; the long-file run (§5.3) gives the real RTF.

**Portuguese samples (2026-11-08).** No session has been recorded yet; recording sessions is what this project
enables. The Portuguese accuracy, drift and long-file steps (5–10) therefore wait for the first recorded session
(per-speaker tracks, e.g. Craig). Until then, a GM-recorded Portuguese reading of 10–20 min with PF2e terms can stand
in for the speed and reliability checks only; accuracy and the S04 decision need real table audio.

Build note: the Vulkan shader-generator sub-build exceeds the Windows 260-character path limit when the build directory
is under `%LOCALAPPDATA%\sargas-recap\tools\...`. Build in a short directory (e.g. `cmake -S <src> -B D:\wvk`) and copy
`bin\Release\*.exe, *.dll` afterwards, or enable Windows long paths.

### 5.1 Environment and provenance

| Item | Value |
|---|---|
| Date of runs | 2026-11-08 (agent CPU and Vulkan smoke tests only; see §5.0) |
| Windows version / build | Windows 11 Pro 10.0.26300 |
| GPU | AMD Radeon RX 9070 XT (CPU: AMD Ryzen 7 9800X3D, AVX-512) |
| AMD Adrenalin version | |
| Windows `DriverVersion` | 32.0.32015.7029 |
| Vulkan `apiVersion` / `driverVersion` (vulkaninfo) | 1.4.359 / 2.0.416 |
| whisper.cpp tag and commit | v1.9.5, release build `b5454` (2026-10-06) |
| Binary source (built: CMake / MSVC / Vulkan SDK versions; or prebuilt: URL + archive sha256) | Prebuilt **CPU-only** `whisper-bin-x64.zip` from https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip, sha256 `6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb`. No prebuilt Windows Vulkan build exists in recent releases (CPU, BLAS and CUDA only); a Vulkan build must be compiled (step 2). **Vulkan build:** compiled locally from tag v1.9.5 (commit `d1be6fde11ac6e0407606b4e42fe72d34add8037`), CMake 4.4.4, Visual Studio Build Tools 2022 17.14.44 (MSVC), Vulkan SDK 1.4.363.0, `-DGGML_VULKAN=ON`. |
| `whisper-cli.exe` sha256 | `331dba46d6427105d2b802cdbc7eae916ea1c5abf9b0d3b5cfe460d8db8e4366` (CPU build); `8fa49e66747a619990debc91de01b9f1319af63dbbbe7c4a131a0714a84ab868` (Vulkan build; local builds are not byte-reproducible, re-hash after a rebuild) |
| ffmpeg version and source | 9.0.2 full build, winget `Gyan.FFmpeg` |
| `ggml-large-v3-turbo.bin` sha256 / size | `1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69` / 1,624,555,275 bytes (matches Hugging Face LFS oid) |
| `ggml-large-v3.bin` sha256 / size | `64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2` / 3,095,033,483 bytes (matches Hugging Face LFS oid) |
| Other models (quantized, VAD) sha256 | |
| Glossary prompt sha256 (from `results.json`) | |
| Prompt diacritics passed intact on Windows? (step 6) | |
| JSON shape matches fixture? Differences: | Yes for v1.9.5 `-ojf`: `npm run parse` on real output reports no warnings for both models (top-level `systeminfo, model, params, result, transcription`; per-token `text, timestamps, offsets, id, p, t_dtw`). |

### 5.2 Vulkan reliability

| Check | Result |
|---|---|
| Vulkan device detected (log line) | `ggml_vulkan: 0 = AMD Radeon RX 9070 XT (AMD proprietary driver) \| uma: 0 \| fp16: 1 \| bf16: 1 \| ... \| matrix cores: KHR_coopmat`; `gpu_device = 0` (2 Vulkan devices found; device 0 is the RX 9070 XT) |
| GPU vs CPU encode time on jfk.wav | turbo 91 ms vs 4,331 ms; large-v3 97 ms vs 4,985 ms |
| Crashes / hangs / driver resets across all runs | none in 8 short-clip runs and 4 runs of the looped 20-min file (agent smoke test); real table audio still to do |
| Long file (≥ 20 min) completes on GPU | yes on a synthetic file only (see below); exit 0 on all 4 runs |
| Output identical across repeats (compare `jsonSha256` of r1 vs r2) | yes on jfk.wav and on the looped 20-min file, both models (JSON identical apart from `systeminfo`); recheck on real audio |
| VRAM use, peak (Task Manager / Adrenalin) turbo / large | |

**Synthetic long-file run (agent, 2026-11-08).** `jfk.wav` looped 110 times with ffmpeg (`-stream_loop 109 -c copy`) into
1,210 s of English speech, sha256 `00d4230a7a08a215e459f345babc3fc35dfff9b9c0374779b759885221ff51bf`. Default flags, `-ojf`, two repeats per model:

| Model | whisper `total time` r1 / r2 | RTF r1 / r2 | Segments | Last timestamp |
|---|---|---|---|---|
| large-v3-turbo | 17.08 s / 16.66 s | 0.014 / 0.014 | 103 | 00:20:10 |
| large-v3 | 110.02 s / 103.39 s | 0.091 / 0.085 | 290 | 00:20:09 |

This shows the build stays stable for 20 minutes of audio and repeats exactly. It does **not** fill §5.3: the audio is one
sentence repeated, with no silence, overlap, Portuguese or real speakers, so these RTFs are a best case and say nothing
about accuracy or drift. Decoding repeated text also behaves differently (turbo produced only 2 distinct segment texts).

### 5.3 Speed (long file, GPU)

| Model | Prompt | VAD | Audio duration (s) | Wall (s) r1 / r2 | RTF r1 / r2 | Load ms | Encode ms | Decode ms |
|---|---|---|---|---|---|---|---|---|
| large-v3-turbo | none | off | | | | | | |
| large-v3-turbo | glossary | off | | | | | | |
| large-v3-turbo | none | whisper-vad | | | | | | |
| large-v3 | none | off | | | | | | |
| large-v3 | glossary | off | | | | | | |
| large-v3 | none | whisper-vad | | | | | | |
| (CPU baseline, optional) | | | | | | | | |

### 5.4 Accuracy on the hand-checked excerpt

Excerpt length: ____ s, ____ reference words, ____ glossary-term occurrences, ____ name occurrences.

| Model | Prompt | VAD | WER | WER (no diacritics) | CER | Term accuracy | Name accuracy | Notable errors (no private text) |
|---|---|---|---|---|---|---|---|---|
| large-v3-turbo | none | off | | | | | | |
| large-v3-turbo | glossary | off | | | | | | |
| large-v3-turbo | glossary | whisper-vad | | | | | | |
| large-v3 | none | off | | | | | | |
| large-v3 | glossary | off | | | | | | |
| large-v3 | glossary | whisper-vad | | | | | | |

### 5.5 Drift / chunk boundaries (from `drift-summary.md`)

| Mode | Chunk s | Chunks | Hard cuts | Interior mean abs Δstart ms | Boundary mean abs Δstart ms | Boundary max abs Δstart ms | Issues (end past chunk, non-monotonic, zero length) | Mean boundary WER | Overall WER full vs chunked |
|---|---|---|---|---|---|---|---|---|---|
| fixed | 20 | | n/a | | | | | | |
| fixed | 25 | | n/a | | | | | | |
| fixed | 30 | | n/a | | | | | | |
| pause | 20 | | | | | | | | |
| pause | 25 | | | | | | | | |
| pause | 30 | | | | | | | | |
| fixed + overlap ___ ms (optional) | | | | | | | | | |

### 5.6 Confidence vs hand-check (excerpt, `-ojf`)

| Model | Segments | Actually wrong | Flagged | Flagged and wrong | Flagged but fine | Wrong but not flagged | Thresholds used |
|---|---|---|---|---|---|---|---|
| large-v3-turbo | | | | | | | |
| large-v3 | | | | | | | |

### 5.7 VAD / pause detection

| Method | Settings | Pauses found | Hard cuts at 30 s max | Effect on WER (excerpt) | Effect on RTF (long) | Text hallucinated in silence? |
|---|---|---|---|---|---|---|
| none | | n/a | | | | |
| whisper.cpp built-in VAD (Silero) | threshold / min speech / min silence | n/a | n/a | | | |
| ffmpeg silencedetect | -30 dB / 500 ms | | | n/a | n/a | n/a |
| ffmpeg silencedetect | -35 dB / 500 ms | | | n/a | n/a | n/a |
| ffmpeg silencedetect | -40 dB / 500 ms | | | n/a | n/a | n/a |

### 5.8 Agent-run Portuguese audiobook benchmark (2026-11-08)

Run by an agent at the GM's request. **Not table audio**: studio-style narration of 19th-century Brazilian Portuguese prose, one
speaker per file, no noise, no crosstalk, no PF2e or English game terms. It compares the two models on Portuguese; it does not fill
§5.3 to §5.7.

- Audio: LibriVox _Histórias Sem Data_ (Machado de Assis, Public Domain Mark), chapters 1, 2, 5 and 8, four readers, 4,828 s in total.
  MP3 hashes matched archive.org's SHA-1 metadata. Converted to 16 kHz mono WAV.
- Reference: Project Gutenberg #33056 (11,472 words).
- Runs: Vulkan build, `-l pt`, no prompt, no VAD, 2 repeats, 16 runs, all exit 0. Outputs are identical across repeats on all 8
  model and chapter pairs.
- Scoring: word error rate with free leading and trailing words, so the LibriVox intro and outro do not count. Both sides are
  normalized for accents and for 1880s spelling (`ph`, `th`, `y`, doubled consonants, initial `h`). Remaining spelling differences and
  any words the reader changed still count, so **the absolute values are upper bounds**; the comparison between models is the useful part.

| Chapter (words) | turbo WER | large-v3 WER | turbo segments / mean length | large-v3 segments / mean length |
|---|---|---|---|---|
| 1 (2,696) | 9.24% | **17.62%** | 788 / 1.2 s | 281 / 3.7 s |
| 2 (3,129) | 9.59% | 10.23% | 511 / 2.6 s | 48 / 27.8 s |
| 5 (2,647) | 7.59% | 7.44% | 870 / 1.2 s | 444 / 2.3 s |
| 8 (3,000) | 8.63% | 10.40% | 114 / 11.5 s | 66 / 19.7 s |
| **All (11,472)** | **8.80%** | **11.37%** | | |

| Model | Wall time, 4,828 s of audio | RTF | Segments flagged low confidence |
|---|---|---|---|
| large-v3-turbo | 109.6 s | 0.023 | 103 of 2,283 |
| large-v3 | 263.4 s | 0.055 | 121 of 839 |

Observations:

- **large-v3 hit a repetition loop** in chapter 1: one phrase of seven words appears 8 times and the output has 228 more words than
  turbo's. That loop explains most of its 17.62%. Without it, the models are close. Turbo showed no such loop here. T09 needs loop
  detection whichever model is chosen.
- Segment length varies by reader from about 1 s to 30 s, on both models. T08 and the review UI cannot assume a typical segment length.
- Turbo often drops punctuation and breaks sentences mid-phrase; large-v3 keeps sentence punctuation. This matters for reading the
  transcript and was not scored.
- Both models are fast enough on this GPU that speed does not decide the choice.

Provisional reading: `large-v3-turbo` is the better default on this audio, because it is faster and did not loop. Whether that holds on
table audio with crosstalk and game terms is untested.

## 6. Findings (to be filled in from the measurements)

### 6.1 Timestamp findings

What the agent can say before any run, from the output format only (to be confirmed):

- `-oj` gives segment-level `offsets.from/to` in integer milliseconds and SRT-style strings. Internally whisper.cpp
  works in 10 ms units, so expect values that are multiples of 10 ms.
- `-ojf` adds per-token offsets, `id`, probability `p` and `t_dtw`. `t_dtw` is -1 unless `--dtw <model>` is given.
  Without DTW, token times come from whisper's timestamp heuristics, so treat them as approximate.
- Word-level output can also come from `--max-len 1` / `--split-on-word`, which re-segments the output. That
  changes segment counts, so it would need its own run if word timing matters.

GM to fill in:

- Segment vs token/word timestamp accuracy (spot-checked by ear at ___ points): 
- Drift over the long file (do full-file timestamps stay aligned to the audio at the end?): 
- Behaviour at chunk boundaries (cut words, repeated words, segments past the chunk end): 
- Segments in silence/music (hallucinations), and whether VAD removes them: 
- Anything T09 must validate or reject (e.g. `end < start`, `end > chunk duration`, non-monotonic starts): 

### 6.2 Confidence findings

- Token probability `p` available: yes / no (only with `-ojf`).
- Does a low `p` match the segments that are actually wrong (table 5.6)? 
- Recommended `low_confidence` rule and thresholds for T09 (or "not useful: do not use"): 
- Other signals worth keeping (e.g. language detection, no-speech probability if present in this version): 

### 6.3 Recommended chunk length and pause-split strategy

GM to fill in from 5.5 and 5.7. Questions to answer:

- Chunk length (the issue proposes a 20 to 30 s default): ____ s target, ____ s maximum, ____ s minimum.
- Split rule: cut at the midpoint of a detected pause nearest the target (`planPauseChunks` in `src/drift.ts`), and
  hard-cut at the maximum when there is none? Keep chunks contiguous (no audio removed), so the chunk-to-source
  map is a pure offset? Or remove long silences, which needs piecewise maps in T08?
- Overlap at hard cuts: needed? If yes, how much, and how should duplicated words be de-duplicated?
- Pause detector: ffmpeg `silencedetect` (settings: ____ dB, ____ ms) vs whisper.cpp built-in VAD vs both
  (silencedetect for planning cuts, built-in VAD inside each chunk). Note: whisper.cpp VAD runs inside whisper
  and does not hand cut points back to us, so it cannot replace a planner that T08 controls. It can only reduce
  hallucination within a chunk.
- Short speech: confirm that short utterances (< 1 s) between pauses survive both VAD settings.

### 6.4 Resumability inputs (what to hash per chunk)

Proposed for T08/T09/T23. The GM should confirm or correct this, mainly by checking determinism (5.2):

| Input | Why |
|---|---|
| sha256 of the chunk's decoded 16 kHz mono PCM, or source file sha256 + chunk start/end ms + decode params + ffmpeg version | Same audio in means same result; ffmpeg version can change resampling. |
| Chunk plan params (target/max/min length, overlap, silencedetect noise dB and min duration) | A changed plan moves boundaries. |
| whisper.cpp version/commit + binary sha256 | Decoding changes between versions. |
| Model file sha256 | Turbo vs large, quantization. |
| VAD on/off, VAD model sha256 and VAD params | Changes what is transcribed. |
| Backend/device (Vulkan vs CPU, device index) | Floating-point differences may change output; confirm with the determinism check. |
| Full argument vector, normalised (language, beam size, best-of, temperature, `-ojf`, max-len, split-on-word) | Any decode param changes output. |
| sha256 of the exact prompt text (UTF-8, normalised line endings) | The glossary prompt changes output; T09 must allow explicit re-transcription after a glossary change. |
| Parser/schema version of the stored output | Re-parse vs re-run. |
| Thread count | Only if the determinism check shows it changes output. |

### 6.5 Known limitations

Of the harness (agent):

- The JSON shape, flags and stderr line formats are taken from the v1.7.x source, not a real run. Step 6 checks
  them.
- Term accuracy is count-based, not aligned.
- The drift comparison is segment-level and text-matched (word Jaccard ≥ 0.5). It is approximate, and with overlap
  enabled the duplicated words show up as insertions in the overall WER.
- The confidence thresholds are placeholders until step 8.
- RTF includes process start and model load.
- `vulkanMentioned` / `cpuFallbackSuspected` are text heuristics over stderr. The raw stderr is kept and is the
  evidence.

Of whisper.cpp / the setup (GM to fill in):

- 

## 7. Recommendation (GM to fill in)

- Model: 
- Invocation (exact flags): 
- Prompt: with / without glossary, and the size limit: 
- Chunking: 
- Confidence: 
- Pinned versions for `tools.lock.json` (#47 `T23`): binary source + sha256, model sha256, VAD model sha256: 

**Outcome: PENDING (human run required)**
