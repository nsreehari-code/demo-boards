# Profile — Journey Domain

> Domain pack for the `profile` journey board. The neutral Journey Strategist
> engine (loaded alongside this file) decides the moves; this file says what this
> journey is about, what data it draws on, and what "aligned" looks like here.

## What this journey is

The seed card holds a **person's name** (for example, `Alex Rivera`). This board
builds a background profile of that person — the kind of read you would do for
resume screening or candidate due diligence: who they are professionally, where
they show up online, their notable work, and recent news.

## Sources this journey draws on

Each facet of the profile is backed by a planted source. Wire a facet card to its
source with `source_def: { "mock": "<key>" }`; the source returns this person's
data for that facet.

| Source key | Holds |
|------------|-------|
| `profile_alex_rivera_identities` | Candidate people who share the name, each with a headline and a confidence. |
| `profile_alex_rivera_linkedin` | Professional background: roles, employers, education, skills. |
| `profile_alex_rivera_social` | Public social and media handles. |
| `profile_alex_rivera_publications` | Patents and papers. |
| `profile_alex_rivera_news` | Recent news and press mentions. |

A source may carry more than a single facet needs; keep each card focused on its
own facet and leave the rest.

## What "aligned" looks like here

This journey is aligned when the board holds a card for each facet of the person,
plus a decision that settles which person we mean:

| Facet card | Tag | Source | Shape |
|------------|-----|--------|-------|
| LinkedIn / Professional Background | `linkedin` | `profile_alex_rivera_linkedin` | source card |
| Social Media Handles | `social` | `profile_alex_rivera_social` | source card |
| Patents & Publications | `publications` | `profile_alex_rivera_publications` | source card |
| News & Press Mentions | `news` | `profile_alex_rivera_news` | source card |
| Identity Disambiguation | `disambiguation` | `profile_alex_rivera_identities` | decision |

Use these titles and tags so the board stays legible.

## Which person we mean

The identities source lists more than one person with this name. The **Identity
Disambiguation** card is a decision: it presents those candidates and lets the
user confirm which one this profile is about. It sits on the board as a decision
the user can act on; the highest-confidence candidate is a fair working
assumption to proceed on in the meantime, so the rest of the profile keeps taking
shape rather than waiting.

When every facet card is present, the identity decision is posed, and no card has
failed, the journey is aligned. Reopen it if the seed name changes to a different
person.
