# Strategist HTTP Test SOT

This file is the source of truth for what the strategist HTTP tests are intended to validate.

It exists to keep the test harness aligned with the Journey Strategist doctrine:

- a journey is a living board, not a fixed workflow
- progress does not require a single mandated sequence
- tests should validate recognizable advancement, surfaced decisions, visible next steps, and board health
- tests should avoid overfitting to one exact intermediate card order or one exact card set

## Test Ladder

The strategist scenarios are intentionally ordered by increasing technical and behavioral complexity.

1. `B1` validates basic runtime wiring only.
2. `A1` validates profile scaffold acceptance shape only, without requiring a fresh strategist cycle.
3. `S1` validates a live seed-to-scaffold journey outcome caused by a fresh strategist cycle.
4. `S2` validates a richer second-domain scaffold outcome without assuming sequence.
5. `S3` validates multi-cycle progress plus observatory-measured value rise.

The scenarios do not need to be at the same strictness level. Each test proves a different layer of the strategist story.

## Acceptance Vs Causality

The suite intentionally separates two different questions:

1. State acceptance: does this board snapshot represent a healthy, recognizable journey scaffold?
2. Live causality: did the strategist just advance the journey from the triggering input?

`A1` answers the first question.
`S1`, `S2`, and `S3` answer the second.

That means a fresh strategist cycle is not mandatory for every strategist-adjacent test, but it is mandatory for any scenario whose claim is that the strategist itself just caused the advancement.

## Global Assertion Rules

These rules apply across `S1`, `S2`, and `S3`.

1. Validate direction, not choreography.
The strategist may advance different subthreads in different orders. A test should not fail because one reasonable facet appeared before another.

2. Validate a minimum recognizable shape, not an exact final shape.
If the required core facets are present, extra sensible facets are allowed.

3. Extra facets are not failures by default.
An extra facet should only count against the test if it is clearly duplicate noise, contradictory clutter, irrelevant sprawl, or causes board health problems.

4. Board health matters in every scenario.
The board should not end the scenario with failed cards, and blocked states should only be treated as acceptable if the scenario explicitly expects a user-facing decision or clarification posture.

5. Visible next steps matter.
The strategist should expose a next move, candidate, decision, or handoff rather than silently finishing with no forward signal.

6. Status should be interpreted semantically.
`advancing` and `aligned` are both acceptable when they fit the scenario. A test should not require one exact status if both are reasonable journey outcomes.

## B1 — Basic Runtime Validation

### Purpose

Prove that the strategist runtime surface is reachable before any live strategist reasoning is evaluated.

### One-sentence outcome

> "I run the strategist preflight, and the hosted board server, strategist boards, one-shot SSE snapshots, and journey observatory wiring all respond correctly."

### Journey under test

No journey behavior is being validated here. This is only a runtime and wiring preflight.

### Assertions

1. The hosted board server responds.
2. The expected strategist boards exist.
3. One-shot SSE board snapshots can be read.
4. The strategist card and observatory card are present where expected.
5. Observatory runtime values are readable and numerically well-formed.

## A1 — Profile Scaffold Acceptance

### Purpose

Prove that the harness can recognize a healthy, legible profile-investigation scaffold without requiring a fresh strategist cycle.

### One-sentence outcome

> "I plant a minimal valid profile-investigation scaffold, and the harness recognizes it as a healthy, legible background-check board without requiring a fresh strategist cycle to have happened just now."

### Journey under test

No live strategist causality is being validated here. This is a state-acceptance check for the profile journey shape.

### Assertions

1. The board contains a multi-card profile-investigation scaffold.
2. The minimum recognizable profile set is present.
Required core set:
background/professional profile
online presence/social
notable work/publications
news/press
3. An identity-disambiguation decision appears.
4. The board remains healthy.
5. Extra sensible profile facets are allowed.

### Non-goals

1. `A1` does not prove that the strategist just created the scaffold.
2. `A1` does not require a fresh strategist attempt count increase.
3. `A1` does not require strategist status or next candidates to have changed in this run.

## S1 — Profile Investigation Scaffold

### Purpose

Prove that a seed-only profile brief can grow into a recognizable background-investigation scaffold because a fresh strategist cycle advanced the board.

### One-sentence outcome

> "I type a person's name and hiring-screen brief, and the whiteboard grows from a seed into a recognizable profile-investigation plan — background, online presence, notable work, news, plus a 'which person is this?' decision card and a suggested next step; the AI finishes and the board is healthy."

### Journey under test

This is a profile-investigation journey. The point is not real web retrieval yet. The point is that the strategist turns a vague seed into a legible investigative board shape.

### Assertions

1. The board decomposes from seed-only into a multi-card journey scaffold.
2. A minimum recognizable profile set appears.
Required core set:
background/professional profile
online presence/social
notable work/publications
news/press
3. An identity-disambiguation decision appears.
4. At least one visible next step appears.
5. The advancing scaffold is attributable to a fresh strategist cycle, not only a pre-existing board state.
6. The strategist status is semantically acceptable, such as `advancing` or `aligned`.
7. The board remains healthy.
8. Extra sensible profile facets are allowed.

### Non-goals

1. `S1` does not require real web browsing.
2. `S1` does not require an exact number of cards.
3. `S1` does not require a fixed creation order.
4. `S1` does not require that only the canonical facets appear.

## S2 — Trip Planning Scaffold

### Purpose

Prove that a concrete trip brief can grow into a recognizable travel-planning board in a second journey domain.

### One-sentence outcome

> "I type a concrete Japan trip brief, and the whiteboard grows into a recognizable travel-planning board — itinerary shape, lodging/Hakone strategy, Tokyo and Kyoto planning, plus a traveler decision or handoff card and a suggested next step; the AI finishes and the board is healthy."

### Journey under test

This is a trip-planning journey. The board should become a useful planning surface, but the exact order of planning threads is intentionally unconstrained.

### Assertions

1. The board grows into a recognizable trip-planning scaffold.
2. At least a minimum core travel set appears.
Suggested recognizable set:
itinerary/day-level pacing
lodging or Hakone strategy
Tokyo planning
Kyoto planning
3. A traveler-facing decision or handoff card appears.
4. At least one visible next step appears.
5. The move contract remains valid.
6. The board remains healthy.

### Non-goals

1. `S2` does not require a bookable-grade final plan in one exact cycle.
2. `S2` does not require hotel, flight, routing, neighborhood, or booking work to happen in a specific order.
3. `S2` does not require one exact set of trip cards if the journey is clearly advancing.

## S3 — Profile Value Campaign

### Purpose

Prove that from a partial but valid profile scaffold, the strategist can continue advancing the journey across fresh cycles and that the observatory makes this progress measurable through rising value.

### One-sentence outcome

> "I start from a partial profile-investigation board, and over fresh strategist cycles the whiteboard expands with missing facets while the observatory's journey-value score rises, the identity decision appears, and the board stays healthy."

### Journey under test

This is still a profile-investigation journey, but now the emphasis is on multi-cycle progress and the observatory's Currency-axis signal rather than only first-cycle decomposition.

### Assertions

1. The partial planted scaffold is preserved rather than regressed.
2. Missing profile facets are added or the coverage clearly increases.
3. The identity-disambiguation decision appears if it was not already present.
4. Observatory `journey_value` rises over the starting value.
5. The final value band reaches an acceptable advancing zone such as `building` or `healthy`.
6. At least one visible next step remains present.
7. The board remains healthy.

### Non-goals

1. `S3` does not require one exact facet to be the next created card.
2. `S3` does not require exact equality of intermediate observatory counts.
3. `S3` does not treat the observatory gauge as the semantic judge of the journey; it uses the gauge as a deterministic measurement aid.

## Alignment Notes For Implementation

When aligning `strategist-http-test.js` to this SOT:

1. Prefer `at least these core facets` over `exactly these facets`.
2. Prefer `coverage increased` over `this specific card was created next`.
3. Prefer `decision surfaced` over `decision surfaced at a fixed step number`.
4. Prefer `next candidates visible` over `one exact phrasing`.
5. Allow extra sensible facets unless they create unhealthy sprawl.
6. Keep assertions journey-semantic, not harness-accidental.