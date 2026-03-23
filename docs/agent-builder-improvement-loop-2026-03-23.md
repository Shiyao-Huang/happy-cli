# Agent Builder Improvement Loop — Codex Runtime + Marketplace Publish Retro (2026-03-23)

Scope: follow-up after the gstack team-template publishing workflow exposed repeated gaps in agent behavior, marketplace tooling discoverability, and environment diagnostics.

This note is meant to feed the **Agent Builder / Agents 提升** loop: after real work, compare effect vs logs, identify why the workflow felt broken, and encode the fixes back into tools + prompts.

---

## 1. What users experienced

The user’s core complaint was effectively:

- “Why is there no tool to publish/update directly to the agent marketplace?”
- “If the loop is broken, you must fix it.”
- “If local logs are insufficient, check the server via `ssh wow`.”

From the operator point of view, the workflow looked broken because:

1. `create_genome` existed, but **team templates are `CorpsSpec`, not `GenomeSpec`**
2. agents repeatedly talked about `POST /corps` as a raw route, not as a first-class publish action
3. local marketplace calls looked flaky because the actual hub was not simply “local dev on localhost”
4. publish failures returned low-context errors (`fetch failed`, `401`) without telling the operator what to do next

---

## 2. Root causes

### Root cause A — publish capability existed, but was not visible enough

The codebase already split marketplace publication into two paths:

- `create_genome` → `GenomeSpec`
- `create_corps` / `/corps` → `CorpsSpec`

But the workflow still felt broken because this distinction was not clearly surfaced in:

- agent-facing guidance
- examples
- CLI ergonomics

Consequence: people assumed there was **no direct publish tool** for team templates, even when the lower-level path already existed.

### Root cause B — environment routing was confusing

Observed reality:

- on the working machine, `localhost:3006` was not a normal local genome-hub dev server
- actual reachable marketplace traffic came through an **SSH tunnel**
- on `ssh wow`, genome-hub was confirmed listening on port `3006`

Consequence: “genome-hub unreachable” could mean:

- the hub is actually down
- `GENOME_HUB_URL` points to the wrong place
- the SSH tunnel is missing
- the tunnel exists but publish still fails because auth is missing

### Root cause C — publish auth failures were under-explained

Once connectivity was established, the next real blocker was:

- `401 Unauthorized`

Meaning:

- publication required a valid `HUB_PUBLISH_KEY`

Consequence: operators could spend time debugging “network” or “tool missing” when the next real action was simply: provide the publish key.

### Root cause D — Codex runtime is weak at communication-heavy coordination

From real task execution and log review:

- Codex builders produced useful code
- but they did **not** reliably:
  - react to mid-flight team-message task redirection
  - emit frequent progress updates
  - support compact/recovery flows that assume writable stdin

Consequence: the team misread “silent but productive” as “stuck / non-cooperative”, and coordination quality degraded even when code output was useful.

---

## 3. What was fixed in `aha-cli`

### 3.1 Direct CLI path for corps publication

Added a direct CLI command:

```bash
aha teams publish-template --file <path-to-corps.json>
```

Purpose:

- publish a `.corps.json` file directly to the marketplace
- avoid relying on auto-publish side effects from team-member registration
- provide a human/operator-friendly alternative while MCP tool rollout depends on daemon lifecycle

### 3.2 Better marketplace diagnostics

Added explicit connection and auth hints:

- when genome-hub is unreachable:
  - suggest checking `GENOME_HUB_URL`
  - suggest an SSH tunnel, e.g.
    - `ssh -L 3006:127.0.0.1:3006 wow`
- when publish returns `401/403`:
  - explain that `HUB_PUBLISH_KEY` is required

### 3.3 Better docs/prompt discoverability

Updated agent-facing surfaces so the publish rule is explicit:

- `create_genome` is for `GenomeSpec`
- `create_corps` is for `CorpsSpec`
- do **not** try to publish team templates via `create_genome`

This was added to:

- agent guide docs
- prompt-builder guidance
- gstack team-template README
- supervisor instructions that mention marketplace evolution actions

---

## 4. Operational lessons learned

### Lesson 1 — distinguish payload type first

Before publishing anything, classify it:

- if it is a **single agent DNA package** → `GenomeSpec` → use `create_genome`
- if it is a **reusable team roster / template** → `CorpsSpec` → use `create_corps`

This classification should happen **before** any route or MCP choice.

### Lesson 2 — connectivity and auth are separate checks

Marketplace publish debug order should be:

1. Is genome-hub reachable?
2. Is the route correct for this payload type?
3. Do we have publish credentials (`HUB_PUBLISH_KEY`)?

Do not collapse these into one generic “publish failed” bucket.

### Lesson 3 — daemon rollout lag is real

New MCP tools written into `aha-cli` are not immediately visible to already-running sessions until the daemon/tool registry reloads.

Implication:

- a new MCP tool can be “implemented in code” but still “missing in the live session”
- CLI paths can serve as an important fallback because they use fresh built code directly

### Lesson 4 — do not use Codex for tasks that require frequent rerouting

Codex is best for:

- bounded
- single-assignment
- code-first

It is poor at workflows that depend on:

- reading team-message corrections as interrupts
- constant visible coordination
- rich task-status narration

---

## 5. Recommendations for Agent Builder

### Recommendation A — inject a publish decision rule

Future builder genomes should explicitly contain:

> When publishing reusable artifacts:
> - use `create_genome` for `GenomeSpec`
> - use `create_corps` for `CorpsSpec`
> - if a direct tool is unavailable in-session, fall back to CLI or raw HTTP only after checking daemon/tool activation state

### Recommendation B — inject a marketplace env triage checklist

Future builder genomes should explicitly contain:

> For marketplace failures, check in order:
> 1. payload type (`GenomeSpec` vs `CorpsSpec`)
> 2. `GENOME_HUB_URL`
> 3. port reachability / SSH tunnel
> 4. `HUB_PUBLISH_KEY`

### Recommendation C — make Codex collaboration requirements explicit

If Codex is used as a builder runtime, its genome/prompt should include:

> After each meaningful sub-step, send a visible task-update or team message.

And coordinators should avoid:

- mid-flight task redirection via chat only

Instead:

- create a new task
- reassign explicitly on the board
- keep tasks atomic

### Recommendation D — keep a CLI fallback for critical operator paths

Critical flows should not exist only as:

- hidden MCP tools
- indirect side effects

There should be a straightforward operator path for:

- publishing genomes
- publishing corps templates
- verifying marketplace connectivity

---

## 6. Practical runbook for future publish incidents

### Publish a role genome

Use:

- MCP: `create_genome`

### Publish a team template

Use one of:

- MCP: `create_corps`
- CLI: `aha teams publish-template --file examples/.../*.corps.json`

### If publish fails

Check:

1. `GENOME_HUB_URL`
2. whether `localhost:3006` is real local hub vs SSH tunnel
3. `ssh wow` and verify remote port `3006`
4. `HUB_PUBLISH_KEY`

### If the tool exists in code but not in-session

Assume:

- daemon/tool registry reload lag

Then:

- restart daemon / start a fresh session
- or use the CLI fallback path

---

## 7. Summary

The loop was not “missing” in a single place. It was broken by a **combination** of:

- weak publish-path discoverability
- confusing local vs remote marketplace routing
- missing auth guidance
- runtime/tool reload lag
- Codex coordination limits

The main takeaway for Agent Builder is:

> real-world quality depends not only on generating correct code, but on generating the right **operational decision rules** and **diagnostic habits** around that code.
