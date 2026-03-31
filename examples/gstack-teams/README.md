# gstack Team Templates

This directory contains a **gstack-first team-template package**:

- `gstack-role-genomes.catalog.json` — supporting role genomes with full `AgentImage` payloads
- `gstack-trio.corps.json` — 3-seat operational full-stack team
- `gstack-squad.corps.json` — 5-seat operational full-stack team
- `gstack-platoon.corps.json` — 7-seat operational full-stack team

## Important schema findings

1. **Legion / team templates should use `LegionImage`**, not `AgentImage`.
2. **Marketplace category for team templates is `corps`**.
3. **Current `LegionMemberOverlay` does _not_ support `skills`, `allowedTools`, or `systemPrompt`.**
   - Supported overlay fields are only:
     - `promptSuffix`
     - `messaging`
     - `behavior`
     - `authorities`
4. Therefore, **gstack skill assignment must live in the member agent images themselves**, not in the legion overlay.

## Publish order

### 1) Publish supporting role agent images

Use each item in `gstack-role-genomes.catalog.json` as the payload blueprint for `create_genome`.

Notes:
- `create_genome` expects `spec` as a JSON string; the catalog keeps it as an object for readability.
- If official publishing is not available yet, replace `@official` with an org/private namespace first.

### 2) Publish legion templates

Preferred paths:
- **Agents / MCP**: use `create_corps` with the `*.corps.json` content as the `LegionImage` `spec` payload
- **CLI**: run `aha teams publish-template --file examples/gstack-teams/<name>.corps.json`
- both publish paths require a valid `HUB_PUBLISH_KEY` accepted by genome-hub

Current codebase finding:
- `create_genome` is for `AgentImage`
- `create_corps` / `api.createCorpsTemplate()` route to genome-hub `POST /corps` to publish `LegionImage`
- if `GENOME_HUB_URL` still points to `http://localhost:3006` but the marketplace is remote, set `GENOME_HUB_URL` explicitly or open an SSH tunnel (example: `ssh -L 3006:127.0.0.1:3006 wow`)

## Operational counting

The advertised sizes — **trio / squad / platoon** — count the **steady-state delivery seats**.

They assume the platform bootstrap path still provides:
- task board / Kanban lifecycle
- self-reflective identity context
- master-led coordination
- optional org-manager bootstrap outside the steady-state seat count

## Design intent

- All work is **task-driven**, not chat-driven
- Smaller teams combine more gstack skills per role
- Larger teams split planning, build, QA/design, and release into narrower seats
- Every role genome includes:
  - explicit Tier 7 `messaging` + `behavior`
  - explicit `allowedTools`
  - explicit `disallowedTools`
  - a `systemPrompt` with a **Sender Identity Protocol**
  - team/task/self-reflection primitives
