# Agent JSON v1 Review — Round 2

Date: 2026-03-18
Status: design review

This document summarizes the second-round review of `agent.json v1` using the four
highest-impact scenarios:

- B. GenomeSpec -> agent.json migration
- C. mutation rollback / regression
- H. evolution oscillation
- E. mutation secret leakage

The purpose of this review is not to add more schema fields blindly. It is to answer:

1. Is `agent.json v1` already good enough as a declaration-layer object?
2. Which problems belong to schema vs engine vs `genome-hub`?
3. What should be done first?

## 1. Executive Summary

Main conclusion:

> `agent.json v1` is already strong enough as a declaration-layer object.
> The largest remaining risks are no longer "missing schema fields", but:
> migration compatibility, mutation security, lineage-aware mutation policy,
> and rollback retention behavior in `genome-hub`.

Important boundary:

- `agent.json` defines:
  - stable definition
  - strategy surface
  - evaluation surface
  - mutation surface
- `genome-hub` owns:
  - evaluation records
  - aggregated scorecards
  - lineage / rollback / retention decisions
- engine owns:
  - runtime execution
  - env / prompt / permission injection
  - current session/runtime state

## 2. Scenario B — GenomeSpec -> agent.json Migration

### Judgment

Migration is feasible, but must not be treated as a "free rename".

### Strong findings

- most identity, runtime, tools, permissions, team-role, behavior fields map well
- some fields should not be forced into v1 as first-class fields because they are
  either:
  - prompt-derived
  - runtime-derived
  - score-derived

### Key correction

The main migration risk is **not** broad field loss.
The main migration risk is **behavioral loss in fields that still matter operationally**.

The most important example is:

- `hooks`

`hooks` are not cosmetic. They are static agent behavior configuration and must not
silently disappear during migration.

### Decision

- During transition, `GenomeSpec` remains the current production authority
- `agent.json` becomes the new canonical candidate and export/import target
- Migration must guarantee:
  - no silent hook loss
  - compat carrying of `responsibilities` / `protocol` if needed
  - deterministic conversion

### Required action

- build `GenomeSpec <-> agent.json` converters
- add golden migration fixtures
- add explicit compat escape hatches for fields not yet promoted

## 3. Scenario C — Mutation Rollback / Regression

### Judgment

Rollback is mostly **not** a schema problem.

### What `agent.json` already provides

- parent lineage link
- parent digest link
- enough identity to locate prior config

### What does not belong in `agent.json`

These should remain external:

- score result
- `discard` decision
- rollback outcome
- aggregate score

### Important correction

Do not conflate:

- `discard` -> evaluation-layer action
- `deprecated` -> market lifecycle state

They are not the same semantic layer.

### Decision

Rollback should be implemented as:

- evaluation result in `genome-hub`
- lineage lookup in `genome-hub`
- retention policy in `genome-hub`
- runtime reload through engine

### Required action

- add retention policy so rollback parents are not garbage-collected too early
- keep `discard` in evaluation records, not in card lifecycle itself

## 4. Scenario H — Evolution Oscillation

### Judgment

Oscillation is primarily a mutation-policy problem, not a schema problem.

### Root cause

Oscillation happens when:

- score targets conflict
- mutation algorithm is greedy
- history is ignored
- mutation surface is wide enough to flip between equally tempting choices

### What schema can do

Schema can help by exposing:

- mutation surface
- routing hints
- optional constraints surface

Schema should **not** attempt to fully solve oscillation.

### Decision

Fix belongs in `genome-hub` mutation policy:

- lineage-aware mutation
- anti-oscillation checks
- historical result comparison

Optional helper surface:

- `routing.constraints`

This is enough as a guardrail surface for now.

No need to hardcode weighted score targets in v1 schema yet.

## 5. Scenario E — Mutation Secret Leakage

### Judgment

This is a real risk, but it is mostly **not** solvable by JSON Schema.

### Root cause

The dangerous step is:

- LLM or mutation system generates new content
- that content is accepted without content-level review

The schema only knows:

- which path may change

It does not know:

- whether the new value is dangerous

### Decision

The real fix belongs in mutation execution pipeline:

- secret scanning
- injection pattern scanning
- tool ceiling checks
- permission ceiling checks

Schema can optionally provide guardrail surfaces such as:

- `routing.constraints`
- future `evolution.ceiling`

But those are secondary to mutation security pipeline itself.

## 6. Corrected Design Conclusions

### 6.1 What `agent.json v1` is already good at

- declaration-layer identity
- runtime intent
- evaluation surface
- mutation surface

### 6.2 What `agent.json v1` should not try to own

- score results
- aggregate quality state
- rollback decisions
- mutation algorithm itself
- mutation security enforcement

### 6.3 Key architecture stance

`agent.json v1` should remain a **clean declaration object**.
Do not overload it with runtime outcomes or evaluation outcomes.

## 7. Corrected Priority Table

### P0 — must do first

1. `GenomeSpec <-> agent.json` conversion functions
   - this is the prerequisite for all migration work
2. minimum config execution path
   - prove `aha run ./agent.json` really works on smallest viable cards
3. hook compatibility preservation
   - hooks may remain in compat/meta temporarily, but must not be lost
4. migration fixtures / golden tests
   - prove existing genomes can round-trip safely enough

### P1 — next major system safety work

1. mutation security guard pipeline
   - content-level mutation safety checks
2. lineage-aware mutation policy
   - prevent simple oscillation loops
3. rollback retention policy in `genome-hub`
   - old parent versions must remain fetchable long enough for rollback

### P2 — important, but not blocking v1

1. formal hooks section in `agent.json`
2. explicit digest spec and canonicalization rules
3. `discard` / `deprecated` policy documentation cleanup
4. richer compat lifting for structured fields

### P3 — future-facing improvements

1. `evolution.ceiling`
2. more structured routing objectives
3. more structured prompt fragment mutation surfaces

## 8. Final Recommendation

Do **not** continue adding fields first.

Do this instead:

1. lock conversion path
2. prove minimum local execution
3. preserve hooks and compat fields
4. shift focus to mutation policy and security pipeline

That is where the real risk now lives.
