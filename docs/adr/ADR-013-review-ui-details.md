# ADR-013: Review UI details

- Status: Accepted
- Date: 2026-11-09
- Task: T14 (#33)
- Related: ADR-005, ADR-010, ADR-011, ADR-012

## Context

T14 puts the effective transcript and the recap draft on a local web page. A page on any site the GM
has open can make the browser send requests to 127.0.0.1, so "localhost" alone protects nothing.
The issue also asks for Foundry events inline, while ADR-012 says they have no verified alignment
until T17 and T18.

## Decision

1. **Access.** The server binds 127.0.0.1 only and accepts one exact `Host`, which stops DNS
   rebinding. A foreign `Origin` is refused on every request. A POST must carry our own `Origin`,
   and `Sec-Fetch-Site`, when sent, must be `same-origin`.
2. **One secret per run.** `recap review` prints a launch URL holding a random token. Opening it sets
   an `HttpOnly; SameSite=Strict` cookie and redirects to a URL without the token. Every request
   needs the cookie, reads included, so other local users cannot read the transcript through the
   port. Every POST also repeats the token, in a form field or `X-Recap-Token`.
3. **Text is escaped by construction.** Pages come from a template tag that escapes every value
   unless it is already built markup. The CSP has no `unsafe-inline`: the page holds no inline script
   or style, and the client reads only server-rendered attributes and writes only `textContent`.
4. **The page works without JavaScript.** Forms post to the same routes as the JSON API and redirect
   back to the line. The small client (esbuild) adds filters, j/k navigation, an unsaved-edit warning
   and a status poll.
5. **Every action calls a CLI service.** Overrides go through `setSegmentOverride`,
   `reconcileToSegment` and `discardUnreconciled`; regeneration through `runStage` with the stages of
   `recap run`, so consent, the session lock and ADR-005 point 7 apply unchanged.
6. **The form records the revision it was rendered from.** If the override changed since (another
   tab, the CLI), the save is refused rather than undoing a newer decision.
7. **Regeneration runs in the background and needs a confirmation** that names what is sent,
   including possible spoilers, because `possible_spoiler` does not change inclusion (ADR-011,
   ADR-012). Corrections are refused while it runs, so what the job records is what it used.
8. **Foundry events are shown, never used.** Their position is estimated from the manifest's wall
   clock origin and labelled as an estimate, or listed apart when there is no origin. Nothing here
   feeds a recap, so ADR-012 point 7 still holds. The raw payload is collapsed and capped.
9. **No new contract.** The API returns the existing `effective-transcript-review`, `review-override`
   and `recap` records.

## Consequences

- T15 can add recap editing and approval as more routes behind the same checks.
- Each server run has a new link; a bookmark does not survive a restart.
- The page is one document with a form per line, which is fine for a session of a few thousand
  lines and untested beyond that.

## Alternatives considered

- **CSRF token only, with open reads.** Rejected: any local process could read the page, and the
  token with it.
- **Accepting `localhost` as a host.** Rejected: it adds a name that can resolve elsewhere, for no
  benefit when the printed URL uses the address.
- **Fastify or Express.** Rejected: `node:http` covers a handful of routes with no new runtime
  dependency.
- **Reusing a confirmation-free regenerate button.** Rejected: one click would send text to a provider.
