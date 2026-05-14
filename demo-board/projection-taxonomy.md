# Projection Taxonomy for Board Live-Cards

This document defines a concrete projection taxonomy for `demo-boards` using the board live-cards model.

The intent is to make card authoring systemic rather than ad hoc. A card should normally belong to one primary projection family, live in one flow plane, and publish one clear state or token for downstream use.

## Core Framing

- A board is a case.
- Live-cards are typed projections over case state, alignment state, operational state, or canonical truth state.
- Gandalf is the intake and ingest plane where new material enters the case.
- Truth alignment is the work of moving uncertain case material toward a managed canonical truth model.
- Truth sets are the canonical alignment target.

In Finbook terms, the truth-set DB and its schema are the contract that the case must move toward. The ingest side is not truth. It is the managed workspace where incoming material is interpreted, clarified, aligned, and only then promoted into canonical truth views.

## Why A Projection Taxonomy Exists

Without a projection taxonomy, cards become arbitrary mixtures of:

- source fetching
- reasoning
- workflow control
- status display
- truth review
- lineage inspection

That makes the board hard to reason about and hard to evolve.

The taxonomy exists to answer three questions before a card is authored:

1. What role does this card play in the case?
2. Which plane of the system does it belong to?
3. What state does it publish for the next step?

If those answers are unclear, the card is probably still ad hoc.

## Projection Families

### 1. Ingest Projection

Purpose:
Bring external observations, documents, events, or operator instructions into the case.

Typical responsibilities:

- intake queue
- batch context
- source metadata
- extraction start state
- normalization start state

Typical inputs:

- uploaded documents
- feeds
- pasted text
- operator notes

Typical outputs:

- evidence candidates
- claim candidates
- artifact candidates
- extraction issues

Canonical host:
Gandalf or other ingest pane.

Finbook reading:
Raw imported finance records enter here before they are aligned to truth-set schema.

### 2. Evidence Ledger Projection

Purpose:
Represent accepted evidence units, provenance, freshness, and linkage readiness.

Typical responsibilities:

- evidence inventory
- provenance
- timestamps
- source confidence
- extraction completeness

Typical inputs:

- ingest outputs
- imported source metadata

Typical outputs:

- evidence tokens
- freshness summaries
- provenance summaries

Canonical host:
Live-cards on the main case board.

### 3. Claim Workbench Projection

Purpose:
Represent candidate claims, current wording, supporting evidence, contradictions, and revision lineage.

Typical responsibilities:

- claim text
- claim status
- support summary
- contradiction summary
- revision chain

Typical inputs:

- evidence tokens
- analyst edits
- clarification outputs

Typical outputs:

- claim tokens
- claim readiness summaries
- claim lineage summaries

Canonical host:
Live-cards on the main case board.

### 4. Issue / Blocker Projection

Purpose:
Track ambiguity, conflict, missing data, schema violations, and workflow blockers.

Typical responsibilities:

- open issues
- blocker severity
- blocked targets
- resolution path
- escalation signals

Typical inputs:

- ingest exceptions
- claim contradictions
- schema validation failures
- workflow failures

Typical outputs:

- blocker tokens
- escalation summaries
- unblock requirements

Canonical host:
Live-cards on the main case board.

Finbook reading:
Truth-set schema mismatches should be first-class issues here, not hidden inside chat.

### 5. Clarification Projection

Purpose:
Record interpretive repair actions that resolve issues or restate claims without losing lineage.

Typical responsibilities:

- clarification prompts
- clarification responses
- target issues
- claim restatements
- operator rationale

Typical inputs:

- issue tokens
- analyst actions
- workflow feedback

Typical outputs:

- resolved issue tokens
- revised claim tokens
- clarification lineage

Canonical host:
Live-cards on the main case board or embedded chat-linked cards.

### 6. Workflow / Step Machine Projection

Purpose:
Show where the case is in its operational procedure and what can run next.

Typical responsibilities:

- current step
- eligibility
- blocked state
- produced outputs
- run history
- next-step recommendations

Typical inputs:

- evidence tokens
- claim tokens
- truth tokens
- blocker tokens

Typical outputs:

- workflow status tokens
- run outputs
- next-step recommendations

Canonical host:
Live-cards on the main case board.

### 7. Truth Alignment Projection

Purpose:
Measure and enforce alignment between case material and the canonical truth-set model.

Typical responsibilities:

- truth-set membership readiness
- schema conformance
- field completeness
- semantic alignment status
- promotion readiness

Typical inputs:

- claim tokens
- evidence summaries
- canonical schema definitions
- canonical truth records

Typical outputs:

- truth candidates
- alignment pass/fail
- schema mismatch issues
- promotion recommendations

Canonical host:
Live-cards on the truth-alignment plane.

Finbook reading:
This is the key projection family for Finbook. The truth-set DB schema is the normative contract.

Operational note:
In systems with batch commit and discard semantics, truth alignment may already be operationally realized through a provisional workspace plus an explicit promotion boundary. In that model, alignment work happens before commit, `discard` rejects the full alignment attempt, and `commit` promotes the aligned state into preserved case truth.

### 8. Truth Book Projection

Purpose:
Present reusable, canonical truths as a stable book for downstream consumption.

Typical responsibilities:

- promoted truths
- grouped truth sets
- truth freshness
- supersession lineage

Typical inputs:

- truth alignment outputs
- promoted truth records

Typical outputs:

- truth-set tokens
- truth book summaries
- downstream reusable facts

Canonical host:
Live-cards or schema-shaped pages over canonical truth data.

### 9. Artifact Derivation Projection

Purpose:
Show artifacts generated from truths and truth sets, plus derivation lineage.

Typical responsibilities:

- artifact inventory
- upstream truth dependencies
- stale or fresh status
- publication status

Typical inputs:

- truth tokens
- truth-set tokens
- workflow outputs

Typical outputs:

- artifact tokens
- lineage summaries
- stale artifact warnings

Canonical host:
Live-cards on the truth plane.

### 10. Case Operations Projection

Purpose:
Give the operator a live operational view of the case across ingest, blockers, workflows, and truth promotion.

Typical responsibilities:

- case health
- active blockers
- pending workflows
- pending promotions
- recent events

Typical inputs:

- ingest summaries
- blocker summaries
- workflow summaries
- truth alignment summaries

Typical outputs:

- case dashboard tokens
- intervention priorities

Canonical host:
Top-level summary cards.

### 11. Lineage / Audit Projection

Purpose:
Show how a truth or artifact came to be, including evidence, clarifications, and workflow runs.

Typical responsibilities:

- provenance chain
- supersession chain
- workflow provenance
- audit checkpoints

Typical inputs:

- truth records
- artifact records
- workflow runs
- evidence provenance

Typical outputs:

- audit views
- lineage summaries

Canonical host:
Live-cards on the truth plane or dedicated review cards.

Operational note:
Git history and git diff can already provide strong operational lineage. They show what changed, when it changed, and what was preserved or rolled back together. A richer semantic lineage layer can be added later without replacing git as the promotion and rollback mechanism.

## Flow Planes

Projection families live in three main planes.

### Gandalf Plane

Purpose:
Intake plane for raw external material and early normalization.

Dominant projection families:

- ingest
- evidence-ledger

### Case Plane

Purpose:
Main reasoning plane for claims, issues, clarifications, workflows, and operator monitoring.

Dominant projection families:

- claim-workbench
- issue-blocker
- clarification
- workflow-step-machine
- case-ops

### Truth Plane

Purpose:
Canonical alignment plane against truth-set storage and schema.

Dominant projection families:

- truth-alignment
- truth-book
- artifact-derivation
- lineage-audit

## Promotion Rules

Truth promotion should not be implicit.

### Claim To Truth Candidate

Minimum conditions:

- sufficient support
- no unresolved blocking issue
- truth-alignment check completed

### Truth Candidate To Canonical Truth

Minimum conditions:

- truth-set schema conformance
- canonical field completeness
- lineage attached

## Operational Promotion Boundary

In some systems, truth alignment is not only a visual or semantic layer. It is also a concrete operational boundary.

The strongest current pattern is:

- a batch or board state acts as a provisional alignment workspace
- evidence ingestion, clarifications, and working knowledge accumulate in that provisional state
- `discard` rejects the entire alignment attempt and rolls it back
- `commit` accepts the attempt and preserves it as promoted case state
- git diff provides operational lineage for the promotion

This means a board can already function as a managed truth-alignment workspace even before every semantic projection is surfaced explicitly.

## Finbook Interpretation

Finbook gives a concrete example of how these projection families fit together.

### Left Side: Intake And Alignment Workspace

The ingest pane is not truth.

It is an orchestration surface where the system:

- receives documents and user directions
- extracts candidate records
- creates or revises claims
- detects ambiguity and blockers
- asks for clarification
- realigns candidate material toward the managed schema

In practice, that means the left-side chat is not a single projection. It is a shell over multiple projection families:

- ingest
- evidence-ledger
- claim-workbench
- issue-blocker
- clarification
- truth-alignment

### Middle: Managed Truth Alignment Layer

This is the most important explicit layer to make visible in Finbook-like systems.

It should show:

- candidate records not yet admitted into truth
- schema conformance state
- required missing fields
- identity ambiguity
- period ambiguity
- dedup uncertainty
- cross-verification claim status
- unresolved blockers

This is the layer that turns “LLM is reasoning a lot” into “the system is managing alignment deliberately”.

In Finbook-like systems today, much of this layer may already exist operationally through the batch git lifecycle. The semantic layer is not being invented from nothing; it is being surfaced over an existing commit-or-discard truth promotion mechanism.

### Right Side: Canonical Truth Book Views

The DB-backed pages are truth-book projections over accepted managed records.

They are not the place for unresolved ambiguity. They are the stable surface where truth-set-aligned records are viewed.

In operational terms, they are the preserved post-promotion state that remains after a batch is committed.

### Cross-Cutting Memory Layer

Finbook also contains knowledge accumulation through a special agent. That knowledge is not itself a truth set.

It should be treated as a supporting memory layer that improves future alignment by storing:

- identity mappings
- recurring processing decisions
- stable interpretation rules

That memory improves ingest and alignment, but does not itself become canonical transaction truth.

## Practical Authoring Rule

Every live-card should declare or at least clearly imply:

1. one primary projection family
2. one flow plane
3. one main published state or token

Multi-purpose cards should be split unless they are explicitly a case-ops summary card.

## Suggested Card Naming Pattern

Use projection family names directly in titles, tags, or card descriptions when practical.

Examples:

- Ingest Queue
- Evidence Ledger
- Claim Workbench
- Open Blockers
- Clarification Queue
- Workflow Step Machine
- Truth Alignment Check
- Truth Book
- Artifact Lineage
- Case Ops Summary

## Minimal Design Test

Before creating a card, answer these questions:

1. Which projection family does this card belong to?
2. Which plane does it live in: Gandalf, Case, or Truth?
3. What token, summary, or state does it publish next?

If those answers are weak, the card definition needs more work before it is authored.