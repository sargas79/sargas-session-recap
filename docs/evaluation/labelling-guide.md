# Labelling guide: segment labels and recap-critical items

Status: spike guide for S01 (#11), 2026-11-07. Schema: [`fixtures/evaluation/label.schema.json`](../../fixtures/evaluation/label.schema.json)
(spike schema `s01-labels/0.1-spike`; T02 (#18) will supersede it or align it with the canonical contracts).
Synthetic example: [`fixtures/evaluation/label-set.synthetic.valid.json`](../../fixtures/evaluation/label-set.synthetic.valid.json).

This guide is for the GM labelling the ~30 min S01 sample. The same rules will later be used to check the
classifier (T11 #29) and the evaluation suite (T20 #34). All examples here are **synthetic** (invented NPCs,
invented dialogue). The table speaks Portuguese and uses PF2e terms in English, so the examples do too.

> **Privacy.** Real labels, real transcript text, speaker-to-person mappings and consent records **never go into git**.
> Keep them in a folder outside the repository (e.g. `%USERPROFILE%\sargas-recap-private\s01\`). Only synthetic
> fixtures (`"synthetic": true`) are committed.

---

## 1. What you are labelling

The unit is one **transcript segment**: one whisper.cpp segment on one speaker's track (one file per speaker).
A segment is identified by:

| Field | Meaning |
|---|---|
| `speaker` | Pseudonymous track ID: `gm`, `p1`, `p2`, ... Never a real name. |
| `start_ms`, `end_ms` | Integer milliseconds on the **shared session timeline** (track offset applied). `end_ms > start_ms`. |

Copy the boundaries exactly from the transcript; do not merge or split segments while labelling. If a segment is
badly cut by ASR, label it as it is and add the `asr_error_suspected` flag.

Each label record has:

- `label`: exactly one of the six labels below.
- `recap_critical`: list of critical items (section 3). Empty or missing means "not recap-critical".
- `flags`: optional context flags (section 4).
- `notes`: free text. **Required** for `mixed` and `uncertain`.
- `text`: optional. Fine in your private copy; in git it is only allowed in synthetic fixtures.

## 2. The six labels

Ask, in order: *who is speaking, in which frame (fiction, mechanics or table), and would a player-facing recap use it?*

| Label | Definition | Typical cues | Recap use |
|---|---|---|---|
| `ic` | A player speaking **as their character**, or declaring what their character does in the fiction. | Quoted speech, first person as the PC ("Kara diz...", "eu abro a porta"), declared in-fiction actions. | Yes |
| `narration` | The GM describing the fiction: scenes, NPC actions and NPC dialogue, consequences, scene framing. | "Vocês chegam...", NPC voices, "o goblin cai", "corta para a manhã seguinte". | Yes |
| `rules` | Mechanics talk that refers to the fiction: rolls, DCs, actions, conditions, initiative, spell rules, degrees of success. | "rola Perception", "é uma Strike", "frightened 1", "três ações", "critical success". | Only the outcome (see 3.6); the mechanics themselves are not narrated. |
| `ooc` | Table talk outside the fiction: jokes, snacks, scheduling, real life, tech problems, talk about other games. | "pausa", "pizza", "meu microfone", "semana que vem". | No (kept, excluded by default) |
| `mixed` | One segment that contains **both** recap-relevant (ic/narration/rules) content **and** ooc content, so the whole segment can be neither included nor excluded without loss. | Speaker changes frame mid-sentence. | Only the relevant part, cleaned. `notes` must say which part. |
| `uncertain` | You cannot decide the label, even after listening to the audio. | Unintelligible ASR, ambiguous frame, sarcasm you cannot read. | GM decides at review. `notes` must say why. |

### Decision rules

1. **Frame beats speaker.** The GM can produce any label: narration when describing, `rules` when calling for rolls,
   `ooc` when talking about the snacks. Players can produce `ic`, `rules`, `ooc` (and `narration` only when the GM
   explicitly hands them narration, e.g. describing their backstory flashback).
2. **NPC dialogue is `narration`**, not `ic`. `ic` is reserved for player characters.
3. **Rules wins over ic only when nothing happens in the fiction.** "Faço uma Strike no goblin" is `ic` (a declared
   action); "Strike usa duas ações?" is `rules`. When a declaration and a mechanics question are fused
   ("ataco o goblin, isso provoca Reactive Strike?"), label `ic` and note the rules question; that is not `mixed`
   because both parts are fiction-relevant.
4. **`mixed` only when ooc is fused with relevant content** and you would have to cut the segment to use it.
   If the ooc part is a throwaway word ("tá, enfim"), ignore it and use the main label.
5. **Jokes:** an in-character joke ("Kara: 'pelo menos o poço não cheira pior que o Tobias'") is `ic` + `joke` flag.
   A joke about the players, the dice or real life is `ooc` + `joke` flag. A joke that also states a real decision
   is `mixed`.
6. **When two labels seem equally right, pick `uncertain`**, don't guess. Uncertain segments are useful data.
   Target: under ~10% uncertain; if you are far above, re-read this guide before continuing.
7. **Don't use the model's output.** Label from audio + transcript, before looking at any Claude classification
   for the same segment.

## 3. Recap-critical items

Mark an item when a correct player-facing recap of the session **must mention it** (omitting it would be a real
omission in S01 metrics). A segment can carry several items. Each item has a `type` and an optional short
neutral `summary` (what the recap should say; in your private copy).

| `type` | Mark when | Extra field |
|---|---|---|
| `decision` | The party commits to a course of action or a choice between options ("primeiro o poço, depois o prefeito"). | - |
| `clue` | New information about the mystery/plot is revealed, by narration, NPC or a successful check. | - |
| `npc_name` | An NPC is named or introduced for the first time this session (or renamed/revealed). | - |
| `loot` | Items, money or rewards are found, given, bought or lost. Include quantity and rank/level if said. | - |
| `action` | A PC action that matters for the story. | `action_status` required |
| `outcome` | The result of a check, attack, or situation that changes the fiction. | `outcome_basis` required |
| `location` | The party arrives somewhere new or the scene moves to a new place/time. | - |
| `other` | Recap-relevant but none of the above (e.g. a PC is cursed, a level-up in the story). | `summary` required |

### 3.1 Proposed vs completed actions (`action_status`)

This is the most common recap error (S01 counts it separately). Mark what the transcript **supports**, not what you
remember happened later.

| `action_status` | Meaning | Example |
|---|---|---|
| `proposed` | Suggested or planned, not yet done. | "E se a gente descer no poço hoje à noite?" |
| `completed` | Declared and carried out in the fiction (or confirmed by narration). | "A wand fica comigo." + "Pego e guardo na mochila." |
| `abandoned` | Proposed and then explicitly dropped. | "Eu ia desenhar o símbolo... deixa." |
| `unclear` | You cannot tell from this segment whether it happened. | "Talvez eu tente abrir..." with no follow-up. |

If a later segment completes a proposed action, mark that later segment `completed` as well; don't edit the earlier one.

### 3.2 Roll vs narrative outcome (`outcome_basis`)

| `outcome_basis` | Meaning | Example |
|---|---|---|
| `roll` | Only the mechanical result was said ("Dezoito? Success."). The recap must not invent what the success revealed. | GM: "Rola aí. Dezoito? Success." |
| `narrative` | The GM narrated the consequence without a stated roll. | "O Well Wight se desfaz em lodo." |
| `roll_and_narrative` | Both in the same segment. | "Critical hit! O golpe atravessa a criatura..." |

A recap claim that states a narrative consequence when only a roll was spoken is an **unsupported claim**
(S01 metric, cause "roll read as outcome").

## 4. Flags and difficult cases

| Flag | Use |
|---|---|
| `overlapping_speech` | Another speaker talks over this segment (crosstalk). Label each speaker's segment on its own track. Different speakers may overlap in time; the **same** speaker's segments must not overlap (the validator rejects that). |
| `joke` | The segment is (or contains) a joke. Combine with the right label (rule 5). |
| `scene_change` | The segment opens a new scene, cut, time skip or initiative/encounter start. Mark the segment where the change is **announced**. |
| `asr_error_suspected` | The transcript text is clearly wrong or truncated compared with the audio. |
| `inaudible` | You cannot hear the speech well enough even in the audio. Usually goes with `uncertain`. |
| `spoiler_or_private` | GM-only information or something a player said that should not appear in a player-facing recap. Leave a note; never include it in shared material. |

**Overlapping speech.** Label from each track's own audio. If the overlap makes one track unintelligible, label that
segment `uncertain` + `overlapping_speech` + `inaudible` instead of guessing what was said.

**Scene changes.** The announcing segment gets `scene_change` and usually a `location` item. Initiative calls get
`scene_change` with label `rules`. Avoid putting the tuning/held-out boundary in the middle of a scene (section 5).

**Recaps of the previous session** said at the table: label `narration`, and note "previous-session recap"; they are
background, not current-session evidence (T13 separates them).

## 5. Tuning vs held-out split

The S01 sample is split into a **tuning** subset (may be used to adjust prompts later) and a **held-out** subset
(only for measuring; never shown to a prompt-tuning loop or pasted into a Claude Project used for tuning).

1. **Choose the split before looking at any model output** for the sample, and record the date in `split.frozen_on`.
   It does not change afterwards. If you have to change it, start a new `sample_id` and say why in `notes`.
2. Record it as half-open time ranges `[start_ms, end_ms)` on the session timeline in `split.tuning` and
   `split.held_out`. Use contiguous blocks (whole scenes), not alternating segments, so context does not leak.
3. Both subsets should contain roleplay, combat, at least one joke, overlapping speech and a scene change.
   Aim for roughly 50/50 by duration; write the method in `split.method`.
4. Optional `split.excluded` ranges are a buffer that belongs to neither subset (e.g. 10 s around the boundary).
5. The validator enforces: all ranges are non-empty and pairwise disjoint (within and across subsets); every labelled
   segment lies fully inside exactly one range. A segment that straddles the boundary must be moved into an
   `excluded` buffer or the boundary moved to a silence.

Example (from the synthetic fixture):

```json
"split": {
  "tuning":   [{ "start_ms": 0,      "end_ms": 300000, "description": "Bloco A" }],
  "excluded": [{ "start_ms": 300000, "end_ms": 310000, "description": "Buffer" }],
  "held_out": [{ "start_ms": 310000, "end_ms": 600000, "description": "Bloco B" }],
  "frozen_on": "2026-11-07",
  "method": "Two contiguous blocks with a 10 s buffer, fixed before any model output was inspected."
}
```

## 6. Consent provenance (outside git)

The label file carries only a pointer: `"consent_ref": "outside-git:<id>"` (the schema rejects anything else).
The consent record itself lives in the private folder outside the repo and should say, for each participant
(by pseudonymous track ID, with the real-name mapping kept only there):

- consent to recording, to local transcription, and to AI processing by the named provider (Claude), separately;
- date, how it was given (written/message/verbal-recorded) and where the evidence is kept;
- any exclusions (e.g. "p3: no use of my track for prompt tuning").

Never paste consent messages, names or signatures into git, issues, PRs or logs.

## 7. Worked synthetic examples

All invented. Speakers: `gm`; `p1` plays Kara (rogue); `p2` plays Tobias (champion); `p3` plays a cleric.

| # | Segment | Text (synthetic) | Label | Critical items / flags | Why |
|---|---|---|---|---|---|
| 1 | gm 1000-9500 | "Vocês chegam a Vila Corvo no fim da tarde. A praça está vazia e o sino da capela não para de tocar." | `narration` | `location`; flag `scene_change` | GM frames a new scene. |
| 2 | p1 10000-14200 | Kara: "Alguém sabe por que esse sino está tocando sem ninguém na torre?" | `ic` | - | PC speech, no new information. |
| 3 | gm 14500-22000 | "Sou Albérico, o sacristão. O sino toca sozinho desde que o poço secou." | `narration` | `npc_name`, `clue` | NPC dialogue is narration (rule 2). |
| 4 | p2 22500-26000 | "Posso fazer um Recall Knowledge de Religion sobre isso? Tenho trained." | `rules` | - | Mechanics question, nothing happens yet. |
| 5 | gm 26200-29000 | "Rola aí. Dezoito? Success." | `rules` | `outcome` (`roll`) | Only the roll was spoken; recap must not invent what was learned. |
| 6 | p3 28500-31000 | "Dezoito no d20, finalmente esse dado presta pra alguma coisa, hahaha." | `ooc` | flags `joke`, `overlapping_speech` | Joke about the dice, over the GM. |
| 7 | p1 40000-46000 | Kara: "E se a gente descer no poço hoje à noite?" | `ic` | `action` (`proposed`) | A suggestion, not a completed action. |
| 8 | p2 46500-53000 | Tobias: "Fechado, primeiro o poço, o prefeito pode esperar." ... "gente, alguém vai pedir pizza?" | `mixed` | `decision`; note says which half to keep | Decision fused with ooc (rule 4). |
| 9 | gm 120000-128000 | "Ok, rolem initiative. Perception para todo mundo, menos a Kara que está em Stealth." | `rules` | flag `scene_change` | Encounter start. |
| 10 | p3 150000-156000 | "...eu vou... não, espera, o... [inaudível]" | `uncertain` | flags `asr_error_suspected`, `overlapping_speech`; note | Can't tell frame or content. |
| 11 | gm 320000-331000 | "Critical hit! O golpe do Tobias atravessa a criatura, e o Well Wight se desfaz em lodo." | `narration` | `outcome` (`roll_and_narrative`) | Roll and consequence together. |
| 12 | gm 340000-349000 | "No lodo vocês acham uma wand of heal de primeiro rank, doze peças de ouro e um símbolo de corvo." | `narration` | `loot`, `clue` | Rewards + plot clue. |
| 13 | p1 350000-354000 | Kara: "A wand fica comigo." Pego e guardo na mochila. | `ic` | `action` (`completed`) | Declared and done. |
| 14 | p2 355000-359000 | Tobias: "Eu ia desenhar esse símbolo... deixa, depois eu volto." | `ic` | `action` (`abandoned`) | Proposed then dropped. |
| 15 | gm 420000-428000 | "Corta para a manhã seguinte. Vocês estão na porta da casa do prefeito." | `narration` | `location`; flag `scene_change` | Time skip. |
| 16 | p3 430000-434000 | "Pausa de cinco minutos? Vou pegar água." | `ooc` | - | Table logistics. |

## 8. Workflow and validation

1. Work in a private copy outside the repo, starting from the synthetic fixture's structure. Set `synthetic: false`,
   `labeller_role: "gm"`, a fresh opaque `sample_id`, `session_ref`, `transcript_ref` and `consent_ref`.
2. Fix and freeze the split first (section 5), then label segment by segment in timeline order.
3. Validate (prints issue codes and paths only, never transcript text):

   ```powershell
   cd spikes\s01-labels
   npm install
   node src\cli.ts "$env:USERPROFILE\sargas-recap-private\s01\labels.json"
   ```

   Exit code 0 = valid, 1 = invalid (issues listed), 2 = usage/IO error.
4. Record the counts it prints (tuning / held-out / excluded segments) in `docs/spikes/S01-manual-baseline.md`.
