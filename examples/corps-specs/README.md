# Proposed Corps / Team Template Specs

These files are **publishable `CorpsSpec` JSON examples** for Aha team templates.

## Why this format

- Team templates should reuse **`CorpsSpec`**, not invent a new schema.
- Marketplace-facing templates should use **`category: "corps"`**.
- `CorpsSpec` supports:
  - canonical genome refs per seat
  - role aliases for UI naming
  - optional specialists via `required: false`
  - shared boot context and task-policy hints

## Key design choice: canonical genome names + local role aliases

The codebase shows a mismatch between **marketplace-canonical genome names** and some **runtime/local role IDs**:

- `builder` → `implementer`
- `reviewer` / `qa` → `qa-engineer`
- `scout` → `researcher`
- `framer` / `solution-architect` → `architect`

So these templates use stable marketplace refs like `@official/implementer` while preserving team-facing labels via `roleAlias`.

## Included templates

- `fullstack-squad.corps.json` — default delivery team
- `rapid-prototype-pod.corps.json` — lean prototype/demo team
- `review-gate-pod.corps.json` — review + verification team
- `research-pod.corps.json` — research-first team that can still ship
- `debug-strike-team.corps.json` — root-cause / regression response team

## Intended publish path

These files are ready to be used as the JSON `spec` payload for a corps/team-template publish flow.
