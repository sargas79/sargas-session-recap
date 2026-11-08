# ADR-010: Recap editorial state, approval records and content-hash canonical form

- Status: Accepted
- Date: 2026-11-07
- Task: T27 (#46)
- Related: ADR-001, ADR-003, ADR-004, ADR-005, ADR-007, T13 (#32), T15 (#35), T19 (#36)

## Context

ADR-001 says recap drafts are immutable artifacts and that edits, editorial state and approvals are
SQLite state, but left the detail open. ADR-007 binds approval to `(recap_revision, content_hash)`,
lets the Foundry importer recompute the hash, and left two questions to this ADR: the exact
canonical form that is hashed, and how edited content gets a revision number once a revision has
been exported (gap G-7 in the implementation plan).

Without answers, T15 could keep the same authoritative state in two places (an `approved` flag in
`recap.json` and in SQLite), and T19 could compute a hash that differs from core's in some corner
(key order, Unicode normalization, citation order). Either one breaks the import rules of ADR-007.

## Decision

### 1. Ownership

| State                                                    | Authoritative home                                 | Contract                        |
| -------------------------------------------------------- | -------------------------------------------------- | ------------------------------- |
| Generated draft of a revision                            | `recap/<revision>/recap.json` (immutable)          | `recap`                         |
| Revision allocation and lineage (`generated` / `fork`)   | SQLite `recap_revisions`                           | internal to T15 (no contract)   |
| GM edits of title, sentences and GM notes                | SQLite `recap_edits` (append-only)                 | `recap-sentence-edit`           |
| Editorial state and its history                          | SQLite `recap_editorial_transitions` (append-only) | `recap-editorial-transition`    |
| Approval records (who approved which hash, when)         | SQLite `recap_approvals` (immutable rows)          | `recap-approval`                |
| Export records (which revision went out with which hash) | SQLite `recap_exports` (immutable rows)            | `recap-export-manifest`         |
| Effective content of a revision (draft + edits)          | nowhere: derived on demand                         | input of `canonicalContentHash` |
| Exported package (content, `content_hash`, approval)     | derived snapshot, written once per export          | `recap-package`                 |

Rules:

- `recap.json` never carries editorial state, edits, reviewer or approval fields; the `recap` schema
  rejects them (`additionalProperties: false`). It is never rewritten.
- **The current editorial state is not stored.** It is the `to_state` of the revision's transition
  with the highest `sequence`, or `draft` when the revision has none. T15 must not add a
  `status` column to `recap_revisions`.
- **Whether an approval is in force is not stored on the approval.** An approval row is a fact (who
  approved which hash at what time). It is in force while the revision's latest transition is the
  `approve` that created it, or an `export` that references it. A content edit or a reopen ends it by
  appending a transition; the approval row is never updated or deleted.
- The `content_hash` stored in transitions, approvals and exports is the value of a derived function
  at that moment. It records what was approved or exported; it is not a second copy of the content.
- The package's `approval` block and the Foundry journal flags are output snapshots (ADR-007). They
  are never read back into the pipeline.

### 2. Effective content

The effective content of revision `n` is computed from `recap/<n>/recap.json` and the `recap_edits`
rows of `n`:

1. For each target (`title`, a `sentence_id`, a `note_id`) take its edit with the highest
   `sequence`. No edit, or `revert`: the draft value. `replace`: the edit's `text` (and, for a
   sentence, its `citations`). `remove`: the sentence is not in the player-facing content (a removed
   GM note is hidden).
2. Player-facing sentences keep the draft order, minus removed ones. Adding new sentences is not an
   edit in v1; it needs a new generated revision.
3. A sentence whose effective edit is `replace` is shown as `edited — verify evidence` (T15).
4. Effective content = `{ language, title, sentences: [{ sentence_id, text, citations }] }`.
   `assertion`, `outcome_basis` and GM notes are carried for the GM but are not player-facing.

### 3. Revision numbering

- **Before export, edits apply in place.** A revision can be edited, reviewed, approved, reopened
  and approved again any number of times without a new number. Nothing outside the tool has seen
  it.
- **An exported revision is frozen for content.** Its title, sentences and citations can no longer
  change, so `(recap_revision, content_hash)` stays unique as ADR-007 requires. GM-note edits are
  still allowed on it: they do not change the hash.
- **A content edit requested on an exported revision `n` forks a new revision `n'`:**
  1. Core (T15) allocates `n'` from the same per-session allocator that recap generation (T13) uses:
     in one SQLite transaction, `n' = max(revision of the session) + 1`, inserted into
     `recap_revisions` with `origin = fork`, `parent_revision = n`. Numbers are never reused; a gap
     after a failed write is allowed.
  2. Core writes `recap/<n'>/recap.json`: the draft of `n` with `recap_revision = n'` and every
     `r<n>:s<k>` / `r<n>:g<k>` ID renamed to `r<n'>:s<k>` / `r<n'>:g<k>` (same `k`). Text,
     citations, assertions, `generated_at` and run IDs are copied unchanged, so `recap.json` is still
     the generated draft, only renumbered. The file is written to a temporary name and renamed; an
     existing directory is an error.
  3. Core copies the effective edit of every target of `n` to `n'` as new `recap_edits` rows (new
     `edit_id`, translated `target_id`), so edits and their `edited — verify evidence` markers carry
     over. Then it applies the requested edit to `n'`.
  4. `n'` starts in `draft`. `n` stays `exported` with its history.
- So every revision has exactly one `recap/<revision>/` directory, and a higher number is always
  newer content, which is what the importer's "newer revision" rule assumes. Forking from an older
  exported revision is allowed and still gets the next number; the UI should warn.
- Regeneration (T13) is unaffected: it allocates the next number with `origin = generated`.

### 4. Content hash

`content_hash = "sha256:" + lowercase hex( SHA-256( UTF-8( canonical JSON of the hashed object ) ) )`

**Covered:** `language`, `title` and, in order, every player-facing sentence's `sentence_id`, `text`
and `citations` (`segment_ids`, `event_ids`).

**Not covered:** GM notes, `assertion`, `outcome_basis`, removed sentences, `generated_at` and every
other timestamp, `campaign_id`, `session_id`, `recap_revision`, run IDs, reviewer, editorial state,
approval and export records, and in a package: footnote IDs, footnote order, evidence order and
evidence context (`session_offset_ms`, `speaker_label`, `excerpt`). The revision is still bound
indirectly: every `sentence_id` embeds it.

**Hashed object.** Exactly these keys, nothing else:

```text
{
  "content_hash_version": 1,
  "language": <string>,
  "title": <string>,
  "sentences": [
    { "sentence_id": <string>, "text": <string>,
      "citations": { "segment_ids": [<string>...], "event_ids": [<string>...] } }
    ...
  ]
}
```

`content_hash_version` is `1` for this ADR. Any change to the canonical form needs a new ADR and a
new version number, so old and new hashes can never be confused.

**Canonical JSON.** A subset of RFC 8785 (JSON Canonicalization Scheme), precisely:

1. **Value types:** objects, arrays, strings and integers only. No `null`, booleans or
   non-integer numbers occur; an implementation must reject them rather than encode them.
2. **Strings** (values and keys) are first normalized to **Unicode NFC**. A string containing a lone
   surrogate (U+D800..U+DFFF not part of a pair) is rejected. Nothing else is changed: no trimming,
   no case folding, no line-ending conversion, so whitespace inside text is significant.
3. **String escaping** (RFC 8785 section 3.2.2.2, identical to ECMAScript `JSON.stringify` for
   well-formed strings): `"` → `\"`, `\` → `\\`, U+0008 → `\b`, U+0009 → `\t`, U+000A → `\n`,
   U+000C → `\f`, U+000D → `\r`, any other U+0000..U+001F → `\u00xx` with lowercase hex. Every other
   code point, including non-ASCII, U+007F, U+2028 and U+2029, is written literally (no `\u`
   escapes).
4. **Numbers:** only `content_hash_version` is a number. All numbers in contracts are integers
   (ADR-003); an integer in the safe range (|n| ≤ 2^53 − 1) is written as plain decimal digits with an
   optional leading `-`, no leading zeros, no exponent, no fraction. Anything else is rejected.
5. **Object keys** are sorted by UTF-16 code units (RFC 8785 section 3.2.3). All keys here are
   ASCII, so this is plain byte order. Duplicate keys (also after NFC) are rejected.
6. **Arrays keep their order**, with one exception defined by the hashed object itself:
   `segment_ids` and `event_ids` are sets. Each is NFC-normalized, deduplicated and sorted by UTF-16
   code units before serialization. `sentences` keeps the content order: reordering sentences
   changes the hash.
7. **No whitespace** between tokens: `,` and `:` without spaces, no trailing newline.
8. The resulting string is encoded as **UTF-8** (no BOM) and hashed with SHA-256.

**From a recap package (T19).** The importer rebuilds the hashed object from `content`: `language`
and `title` as given; for each sentence in order, `segment_ids` = the `ref`s of every evidence with
`kind: segment` in the footnotes listed by `footnote_ids`, and `event_ids` likewise for
`kind: event`; a `footnote_id` missing from `footnotes` rejects the package. The exporter (T15) must
therefore write, for every sentence, footnotes whose evidence refs are exactly that sentence's
citations. It is free to group or share footnotes.

**Implementation.** `packages/contracts/src/content-hash.ts` exports `canonicalContentObject`,
`canonicalJson`, `canonicalContentJson`, `canonicalContentHash` (synchronous, returns
`sha256:<hex>`) and `recapContentFromPackage`. SHA-256 is a small pure-JS implementation in
`sha256.ts`, not WebCrypto: `crypto.subtle` exists only in secure contexts, and a Foundry server
reached over plain `http://` on a LAN is not one. Core and the Foundry module import the same code;
an independent reimplementation must reproduce the worked example below.

### 5. Worked example

Input: `content` of `fixtures/contracts/recap-package/valid.json` (revision 2, two sentences, the
second citing a segment and a Foundry event). Canonical JSON (one line, 460 bytes of UTF-8):

```text
{"content_hash_version":1,"language":"pt","sentences":[{"citations":{"event_ids":[],"segment_ids":["01JBX7Q8M2N4P6R8S0T2V4W6XY:12:3"]},"sentence_id":"r2:s0","text":"O grupo chegou a uma ponte de pedra coberta de musgo."},{"citations":{"event_ids":["fvtt:01JBX7A0B1C2D3E4F5G6H7J8K9:42"],"segment_ids":["01JBX7Q8M2N4P6R8S0T2V4W6XY:13:0"]},"sentence_id":"r2:s1","text":"Bruno procurou armadilhas e notou a Vela escondida."}],"title":"Sessão 7: A ponte de pedra"}
```

Expected hash:

```text
sha256:e560d03af4d61e67452491c4756ab3a4e2171c1c520d706b16147ef69987849b
```

The same hash results when the title is given in NFD (`a` + U+0303 instead of `ã`), when the input
JSON is pretty-printed or has its keys in another order, when a GM note is added, edited or removed,
and when footnotes are regrouped. Changing one character of a sentence, adding or removing a
citation, or swapping the two sentences changes it. `packages/contracts/test/content-hash.test.ts`
asserts each of these and that this file prints the hash above.

### 6. State transitions

States: `draft` → `reviewed` → `approved` → `exported`. Every transition appends one
`recap-editorial-transition` row with the effective `content_hash` after it.

| Current state                   | Action                                                                                        | Trigger        | New state        | Approval in force?                      | Notes                                                                           |
| ------------------------------- | --------------------------------------------------------------------------------------------- | -------------- | ---------------- | --------------------------------------- | ------------------------------------------------------------------------------- |
| (new)                           | generate (T13) or fork                                                                        | —              | `draft`          | no                                      | no transition row; no rows means `draft`                                        |
| `draft`                         | mark reviewed                                                                                 | `review`       | `reviewed`       | no                                      |                                                                                 |
| `reviewed`                      | approve                                                                                       | `approve`      | `approved`       | yes, new `recap-approval` with the hash | approving straight from `draft` is not allowed                                  |
| `reviewed`                      | reopen                                                                                        | `reopen`       | `draft`          | no                                      |                                                                                 |
| `approved`                      | reopen (revoke)                                                                               | `reopen`       | `draft`          | **no longer**                           | approval row kept as history                                                    |
| `draft`, `reviewed`, `approved` | edit title, sentence text or citations, remove or revert a sentence, so that the hash changes | `content_edit` | `draft`          | **no longer** (if it was)               | any content or citation change; re-approval needs `review` then `approve` again |
| any                             | edit that leaves the hash unchanged (e.g. same text, reordered citations)                     | —              | unchanged        | unchanged                               | no transition row                                                               |
| any                             | GM-note edit (replace, remove, revert)                                                        | —              | unchanged        | unchanged                               | GM notes are not hashed; also allowed on `exported`                             |
| `approved`                      | export, approval hash = current hash                                                          | `export`       | `exported`       | yes                                     | writes the package and a `recap-export-manifest` row                            |
| `approved`                      | export, approval hash ≠ current hash                                                          | —              | unchanged        | —                                       | **refused**; cannot happen if edits are recorded, checked anyway                |
| `draft`, `reviewed`             | export                                                                                        | —              | unchanged        | —                                       | **refused**: no approval in force                                               |
| `exported`                      | export again (lost file)                                                                      | `export`       | `exported`       | yes                                     | same hash, new export row; the package content is identical                     |
| `exported`                      | content edit                                                                                  | —              | `exported` (`n`) | yes, for `n`                            | refused in place; forks `n'` (section 3) and applies the edit there as `draft`  |
| `exported`                      | reopen                                                                                        | —              | —                | —                                       | **refused**: an exported revision is terminal                                   |

A re-approval after an edit is a new approval row with the new hash. Reverting an edit after
approval does not resurrect the old approval, even if the hash returns to the approved value: the
approval ended with the `content_edit` transition.

Export also re-checks, at export time, that the package validates against `recap-package` and that
`canonicalContentHash(recapContentFromPackage(package.content))` equals the approval's hash. T15
also refuses export if a cited segment has gained a `spoiler` or `privacy` exclusion since approval
(excerpts come from the effective transcript at export time).

## Consequences

- No editorial or approval state is authoritative in two places: state is the transition log,
  approvals and exports are immutable facts, content is the draft plus the edit log.
- T15 implements: the effective-content builder, the five transition triggers with their guards,
  the fork, and export gating. JSON Schema cannot check cross-row rules (`target_id` belongs to the
  revision, `sequence` is unique, transitions chain `from_state` = previous `to_state`); T15 does.
- T19 recomputes the hash with `canonicalContentHash(recapContentFromPackage(pkg.content))` and
  compares it with `content_hash` and `approval.approved_content_hash` (ADR-007).
- Approval is not invalidated by changes the players never see (GM notes, evidence excerpts). The
  importer still sanitizes all text (ADR-007), because excerpts are not covered by the hash.
- A whitespace-only or line-ending-only edit changes the hash. T15 should normalize line endings to
  `\n` and text to NFC when it stores an edit, so the editor does not create spurious changes.
- Every exported revision is frozen, so revision numbers can grow faster than generations. That is
  intended: the number is a version, not a generation count.

## Alternatives considered

- **Editorial state and approval inside `recap.json`.** Rejected: the draft would no longer be
  immutable, and the state would exist in the file and in whatever SQLite caches (ADR-001).
- **A `status` column next to the transition log.** Rejected: two places that can disagree.
- **Allocate the new revision at export time instead of at the first post-export edit.** Rejected:
  revision `n` would then hold content in SQLite that differs from what was exported as `n`.
- **Forks without a directory (revision = base revision + edit set).** Rejected: breaks ADR-004's
  "the revision names `recap/<revision>/`" and makes sentence IDs disagree with the revision.
- **Full RFC 8785 with floats, booleans and `null`.** Not needed: the hashed object has none, and
  rejecting them avoids the hardest part of JCS (ECMAScript number formatting).
- **Hash the whole package `content` including footnotes and excerpts.** Rejected: footnote layout
  and excerpts are derived at export time; hashing them would make the approval depend on export
  formatting and on transcript projection changes the GM did not approve or see.
- **Keep citation order significant.** Rejected: citation order has no meaning for players, and the
  package can only express it through footnote grouping, which the exporter is free to choose.
- **WebCrypto `crypto.subtle.digest`.** Rejected: async, and missing in non-secure contexts such as
  a Foundry server on `http://` in a LAN. A 100-line pure-JS SHA-256, tested against `node:crypto`,
  works everywhere.
