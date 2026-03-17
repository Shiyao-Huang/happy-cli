# Launch Minimal-Delta Addendum (2026-03-18)

This addendum narrows the previous architecture doc for launch execution.

## 1. Launch rule
Do **not** rewrite GenomeSpec from scratch in this sprint.
Use **minimal additive changes** on top of the existing schema and runtime flow.

## 2. Gene Schema: launch delta only
Existing code already covers most of the user-requested DNA:
- hooks / skills / MCP / tools / systemPrompt
- protocol / behavior / messaging
- memory.iterationGuide / learnings
- resume / workHistory / reviews
- modelScores / preferredModel

### Required launch additions
Add only the missing fields to the existing canonical spec:
- `trigger`
- `provenance`
- `evalCriteria`
- `costProfile`
- `lifecycle`

### Important normalization
Even in minimal mode, keep runtime labeling explicit.
If missing in the canonical runtime-facing type, add/normalize:
- `runtimeType?: 'claude' | 'codex' | 'open-code'`

## 3. Classification + memory task
This remains a separate track from Gene Schema:
- `distributionType: 'org' | 'runtime' | 'market'`
- evolution / mutation linkage
- long-term memory persistence schema

## 4. Help+Supervisor task
Do not redesign the whole supervisor loop.
Use existing cursor state and add only:
- runtime-aware log reading for Codex evidence
- help request / prompt template glue
- scoring display wiring in Agent view / marketplace UI

## 5. Skill mapping for this session
The named gstack skills are **not installed in this Codex session**.
Use these fallbacks:
- `/plan-eng-review` -> `mermaid-architect` + manual eng review
- `/browse` -> `agent-browser`
- `/review` -> manual paranoid code review + test sweep
- `/qa` / `/qa-only` / `/qa-design-review` -> manual QA + browser validation + screenshots
- `/ship` / `/document-release` -> manual workflow unless skills are installed later

## 6. TDD rule
All execution stays on strict micro-subtasks:
- RED -> failing test first
- GREEN -> minimum implementation
- REFACTOR -> clean while keeping green

