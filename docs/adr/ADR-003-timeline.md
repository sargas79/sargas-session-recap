# ADR-003: Timeline: integer milliseconds and sample offsets

- Status: Accepted
- Date: 2026-11-07
- Task: T02 (#18)
- Related: ADR-004, T05 (#22), T06 (#25), T08 (#26), T09 (#28), T18 (#31), T22 (#43)

## Context

Most subtle bugs in this project will be timeline bugs (plan section 5, risk 3). Audio arrives as
several per-speaker fragments with their own start times and sample rates; a Discord reconnect splits
a track; chunks for ASR join fragments and remove long pauses; whisper.cpp reports times relative to
the chunk; Foundry events arrive with a different wall clock. Floating-point seconds accumulate
rounding error and make outputs non-deterministic across platforms.

## Decision

### Units

- **Stored contracts never contain floats for time.** Times are integer milliseconds (`*_ms`) or
  integer sample offsets (`*_sample`, `sample_count`). The schemas declare them `type: integer`.
- Other measurements follow the same rule: ASR confidence is `confidence_permille` (0–1000), cost is
  `cost_micro_usd`.
- Wall-clock instants used in arithmetic are integer Unix milliseconds (`*_unix_ms`). Audit
  timestamps that are only displayed (`created_at`, `sealed_at`) are RFC 3339 strings.
- Conversions use integer arithmetic: `ms = floor(sample * 1000 / sample_rate_hz)`. Never store a
  value that was round-tripped through seconds as a float.

### Session timeline

- **Session offset zero is the sync marker.** `session offset` is a signed integer in ms; audio before
  the marker has negative offsets.
- `manifest.timeline.origin` records how zero was set: `sync-marker` (captured marker) or
  `provisional` (import without a marker; the import's configured start offset defines zero).
  `origin_wall_clock_unix_ms` is the marker's wall-clock time when known.
- Each fragment has `fragment_start_offset_ms`: the session offset of its sample 0. The session
  offset of sample `s` is `fragment_start_offset_ms + floor(s * 1000 / sample_rate_hz)`.
- Every derived time carries `timing_uncertainty_ms`, a non-negative bound on its error. Uncertainty
  is never shrunk by a later stage; a mapped time's uncertainty is at least that of its source.
- Discontinuities (reconnects, gaps, clock resets) are recorded in `manifest.timeline.discontinuities`
  with their offset, the missing duration when known and their own uncertainty. A reconnect starts a
  new fragment; it never shifts earlier fragments.

### Chunk-to-source maps

- A chunk (T08) is a concatenation of pieces of fragments of one speaker, with removed pauses. Its map
  is **piecewise**: an ordered list of pieces `(chunk_start_ms, fragment_id, fragment_start_sample,
sample_length)`. The chunk-plan contract itself is defined in T08; this ADR fixes its semantics.
- A segment stores both views:
  - `chunk_start_ms` / `chunk_end_ms`: as reported by ASR, relative to the chunk audio.
  - `start_offset_ms` / `end_offset_ms`: mapped to the session timeline through the piecewise map.
  - `source_spans`: the fragment sample ranges it covers. A segment that crosses a removed pause or a
    fragment boundary has more than one span. There is always at least one.
- Mapping requirements, property-tested in T08 (`fast-check`): round-trip identity for any time that
  falls inside a piece, monotonicity, and no lost short segments. T08 defines how a time exactly at
  a junction between two pieces maps; whatever the rule, the mapped uncertainty must cover the
  removed pause.
- **Junction rule (T08).** Pieces are half-open, `[chunk_start_ms, chunk_start_ms + duration_ms)`. A
  chunk time exactly at a junction maps to the first millisecond of the later piece as a start
  (`edge: 'start'`) and to the exclusive end of the earlier piece as an end (`edge: 'end'`). Either
  way the mapped uncertainty is the larger uncertainty of the two pieces plus the session gap
  between them, so it covers the removed pause. Cut points are integer ms, converted to samples with
  `sample = ceil(ms * sample_rate_hz / 1000)`, which inverts exactly under the floor rule above
  (a fragment's last piece ends at `sample_count`, so a sub-millisecond tail stays attached to it).
  Chunk audio is extracted to `duration_ms` per piece, which keeps chunk time exactly on this map.
- The chunk-plan contract is `chunk-plan` (`chunk-plans/<plan hash>.json`, written by the
  `chunk-plan` stage). Chunks are split only at pauses or between fragments, never inside
  speech; see `packages/core/src/transcribe/chunk-plan.ts`.

### Foundry events

- Foundry envelopes keep raw timing only (`observed_at_unix_ms`, `clock_uncertainty_ms`). Alignment to
  the session timeline is a separate artifact (T18); the envelope is never rewritten with a session
  offset, and the schema rejects one.

## Consequences

- Identical inputs produce byte-identical timing on Windows and Linux.
- Every stage that produces times must do integer conversion and propagate uncertainty; T08, T09 and
  T18 test this.
- Sub-millisecond precision is available only through sample offsets, which is where it matters.
- A provisional origin can be corrected by alignment later without rewriting stored segments.

## Alternatives considered

- **Float seconds** (what whisper.cpp and ffprobe print). Rejected: rounding drift and
  platform-dependent formatting. Parsers convert at the boundary (T22, T09).
- **Integer microseconds everywhere.** Rejected: more precision than any source has, and sample
  offsets already give exactness where needed.
- **Recording-start as zero.** Rejected: with several tracks and a bot that joins late there is no
  single recording start; the sync marker is the one point all sources can agree on.
