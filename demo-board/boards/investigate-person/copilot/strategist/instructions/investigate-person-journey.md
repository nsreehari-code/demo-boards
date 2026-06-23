# Investigate Person — Journey Domain

> Domain pack for the `investigate-person` board. The neutral Journey Strategist
> engine decides the moves; this file only supplies the domain — what the journey
> is about, the terrain it sits on, and what "aligned" looks like here.

## What this journey is

A **background read on a person** — the work a recruiter, a due-diligence analyst,
or a verifier does: who the subject is, where they show up publicly, and whether
anything about them needs a closer look. It is an ongoing file that stays current
as documents and findings arrive, not a one-shot report.

## Where it begins

- **`card-investigate-query`** — `card_data.query` holds the subject's name and
  the investigator's intent (role, employer, city, a known handle, and *why*).
- **`card-investigate-intake`** — a postbox; uploaded documents land in
  `card_data.files`, read with `inspect.file-contents`. A resume or dossier is
  usually the richest, most reliable source there is.

Either seed alone is enough. Read them yourself — the objective is whatever the
subject and intent in these seeds turn out to be.

## The terrain it ships with

The board already carries a working scaffold:

- an **identity hub** that, in one pass, disambiguates the person and harvests
  their public footprint, publishing `candidates` and a `subject_profile`
  umbrella — `identity`, `linkedin`, `social`, `news`, and `notable_signals`
  (anything genuinely adverse: litigation, criminal record, sanctions, a major
  controversy, surfaced only when there is real evidence);
- **lenses** that each present one channel of `subject_profile` and quietly mute
  themselves when that channel is empty.

That scaffold is the floor, not the ceiling. The subject's profession and the
investigator's intent will often call for footprints it does not yet cover.

## What "aligned" looks like here

- the subject is identified — or proceeding on the strongest candidate — with the
  disambiguation posed when more than one person genuinely fits;
- every channel the subject actually has is shown, and the empty ones say so;
- anything in `notable_signals` is given the attention its weight warrants;
- the read stays current when a new document arrives or the seed is re-pointed to
  a different person.
