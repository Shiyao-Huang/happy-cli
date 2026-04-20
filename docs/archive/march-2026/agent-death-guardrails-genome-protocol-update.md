# Agent-Death Guardrails: Genome / Protocol Update Recommendations

## Why this document exists

The RCA task (`on3Z7kTSFhVN`) and subsequent repair tasks show that several agent deaths were not caused by one bug alone. They came from a combination of:

- context overflow without timely compaction
- lost work after agent death
- OOM-prone validation habits
- single-point coordination failure when Master disappears
- excessive concurrent Claude pressure

Some of these now have direct code fixes in progress (`[P0-1]` to `[P0-4]`, plus the P1 cleanup task). This document covers the **non-code guardrails** that should be added to role genomes, task protocol, and operating defaults so the same failure modes do not recur.

## Evidence base

### RCA evidence

- `supervisorScheduler.ts:338-340` skipped auto-compact for sessions missing `claudeLocalSessionId` or writable `stdin`.
- `sessionManager.ts:549-561, 781-784` dropped child exit state without a dead-session report.
- `heartbeat.ts:138-143` could crash the daemon on `readFileSync` / `JSON.parse`.
- `claudeLocalLauncher.ts:85-136` retried forever without backoff.
- `sdk/query.ts:369` leaked `process.on('exit', cleanup)`.
- `session.ts:57-60` leaked keepAlive intervals.

### Existing policy already present

There is already a good baseline in `aha-cli/src/claude/team/alwaysInjectedPolicies.ts`:

- call `get_context_status` at large-task start / after heavy reads / before long summaries
- if `usedPercent >= 70`, compact after the current subtask
- if `usedPercent >= 85`, compact immediately

There is also already a good team baseline in team agreements:

- status updates at start / blocked / finish
- handoffs inside Kanban cards
- blocker escalation to Master
- done means code + tests + docs + signoff

**Conclusion:** the biggest gap is not “no rule exists”; it is **insufficient enforcement, poor taskization, and missing recovery/observability around the rules**.

---

## Recommendation 1 — Compact Threshold Protocol

### Goal

Prevent context-overflow deaths from recurring as “silent operator error”.

### Genome/spec updates

#### Master

Add to responsibilities/protocol:

- Require a context-status check for log-heavy, RCA-heavy, or multi-file investigation tasks.
- When assigning a task likely to exceed one context window, split it into smaller board-visible slices up front.
- Treat “large task started without context check” as a protocol violation, not a soft preference.

#### Builder / Scout / QA

Add to protocol:

- Call `get_context_status`:
  - at task start for large or investigative work
  - after reading many files/logs
  - before long synthesis / report comments
- If `usedPercent >= 70`, leave a short task comment or status note that compact is planned after the current subtask.
- If `usedPercent >= 85`, compact immediately before further analysis or writing.
- If `get_context_status` fails, do not silently ignore it; note the failure briefly on-task and avoid large context accumulation until the next checkpoint.

### Workflow updates

- For RCA / debug tasks, the first task comment should include:
  - scope
  - first inspection plan
  - context-health check (or explicit tool failure)
- For long-running investigations, require periodic “checkpoint comments” instead of one giant final dump.

### Runtime / observability updates

- Keep `AHA_AUTO_COMPACT_THRESHOLD=85` as the automatic threshold.
- Make auto-compact **eligibility** explicit:
  - session can compact
  - session cannot compact because control channel is missing
- Never silently skip non-compactable sessions; emit a warning / metric / marker.

### QA / acceptance signal

- Incident tasks show at least one context-health checkpoint.
- Non-compactable sessions are visible in logs/telemetry instead of disappearing from protection coverage.

---

## Recommendation 2 — Incremental Commit Checkpoint Protocol

### Goal

Reduce code loss when Builder or another worker dies mid-implementation.

### Genome/spec updates

#### Builder

Add to responsibilities/protocol:

- After each completed subtask or meaningful green-test checkpoint, create a commit before switching scope.
- If a risky refactor or repair slice lasts more than ~30 minutes, checkpoint progress before continuing.
- Handoffs must include:
  - task ID
  - changed files
  - validation performed
  - latest safe commit / checkpoint state

#### Master

Add to protocol:

- Do not assign large repair work as one undivided task if it contains multiple independent fixes.
- For incident work, define expected checkpoint boundaries when creating subtasks.

#### QA

Add to protocol:

- Validate against explicit patch slices / task IDs, not an ambiguous moving branch state.

### Workflow updates

- For multi-defect incident work, prefer:
  - one parent repair task
  - one task per concrete defect/fix lane
  - one commit or checkpoint per lane
- If a worker is blocked before checkpointing, they must leave a task comment summarizing current diff state.

### QA / acceptance signal

- Task comments mention changed files and checkpoint state.
- Large fixes are reviewable in slices instead of one opaque mega-diff.

---

## Recommendation 3 — OOM-Safe Validation Protocol

### Goal

Avoid repeating deaths caused by full-repo type-checks or memory-heavy validation commands.

### Genome/spec updates

#### Builder

Add to protocol:

- Do not run raw full-repo `npx tsc` by default on large repos during incident work.
- Prefer `tsc_check(path)` or scoped validation first.
- Use the provided type-check tooling that already selects the correct Node version and sets memory limits.
- Record the exact validation scope in the task comment (e.g. targeted tests, scoped type-check, or full repo check if truly required).

#### QA

Add to protocol:

- Start with regression tests tied to the changed lane.
- Escalate to broad validation only when the patch surface or risk profile requires it.

#### Master

Add to responsibilities:

- Include expected validation scope in repair tasks, especially when full validation is known to be expensive or unstable.

### Tooling guidance

Evidence in repo shows this already exists:

- `tsc_check` tool is implemented in `aha-cli/src/claude/mcp/supervisorTools.ts`
- it uses the correct Node version and `NODE_OPTIONS="--max-old-space-size=8192"`

So the protocol change should be:

- **promote `tsc_check` to the default validation path**
- treat raw ad-hoc full type-check as an explicit exception

### QA / acceptance signal

- Validation notes describe scope and tool used.
- Incident fixes do not die on avoidable full-repo OOM checks.

---

## Recommendation 4 — Master Failover / Coordination Continuity

### Goal

Prevent the whole team from stalling when Master disappears.

### Genome/spec updates

#### Master

Add to protocol:

- Maintain one visible coordination task as the canonical routing surface.
- For incident work, keep current owner / next owner / next decision visible on-task.

#### Help-Agent / Supervisor

Add or strengthen capabilities/protocol:

- If Master is absent while active tasks exist, assume temporary coordination responsibility.
- Route immediate unblockers first:
  - task assignment gaps
  - QA waiting without task
  - Builder patches with no acceptance owner
- If the absence persists, escalate toward replacement / recovery rather than waiting silently.

#### Workers (Builder / Scout / QA)

Add to protocol:

- If Master is absent and task routing is stale, use `@help` / `request_help` with evidence instead of waiting indefinitely.
- Preserve task-truth on the board; do not let coordination switch to chat-only.

### Workflow updates

- Incident teams should always have:
  - one coordination task
  - one fallback coordination lane (`help-agent` or supervisor)
- User manual status changes (`humanStatusLock`) must trigger explicit clarification rather than silent reinterpretation.

### QA / acceptance signal

- When Master disappears, another role visibly takes over routing instead of work freezing.

---

## Recommendation 5 — Claude Concurrency Limit / Spawn Discipline

### Goal

Reduce mass-death risk from too many heavy Claude sessions starting or reasoning at once.

### Genome/spec updates

#### Master

Add to responsibilities/protocol:

- Cap active mainline Claude workers for incident teams unless there is explicit reason to exceed the cap.
- Prefer reuse of existing agents before spawning new Claude seats.
- Stagger heavy spawns instead of launching many high-context sessions simultaneously.

#### Suggested default policy

- Default cap: **4 mainline Claude workers** per incident team
- Above that:
  - require explicit justification
  - prefer Codex / existing seats / serialized investigation
- Stagger new heavy workers by ~15–30 seconds when they will ingest large prompts or logs

#### Workers

Add to protocol:

- Do not request extra helpers for convenience when the current team can already execute the lane.
- When asking for another worker, state why parallelism is worth the added runtime pressure.

### Runtime / observability updates

- Add a warning when a team exceeds the configured active-Claude threshold.
- Consider exposing per-team runtime mix (Claude vs Codex vs bypass) to coordinators.

### QA / acceptance signal

- Teams do not silently fan out into high-risk concurrency during incident response.

---

## Role-by-Role Suggested Genome Additions

## Master

### Add responsibilities

- Enforce task slicing and checkpoint boundaries on high-risk repair work.
- Limit high-risk concurrent Claude fanout.
- Ensure every active repair lane has both an implementer and a validation owner.

### Add protocol

- Require context-health checks for heavy RCA/debug tasks.
- Require changed-files + validation + checkpoint evidence in every handoff.
- If a human manually reopens a task, clarify whether it is:
  - status correction
  - reopened investigation
  - a new follow-up lane

## Builder

### Add responsibilities

- Preserve work through checkpoint commits during multi-slice repairs.
- Prefer OOM-safe validation paths.

### Add protocol

- `get_context_status` on large repair work; record failure if unavailable.
- Commit after each completed subtask / green checkpoint.
- Prefer `tsc_check` or scoped checks before full type-check.
- Leave changed files + validation + checkpoint in task comments.

## QA

### Add responsibilities

- Produce a regression matrix early for incident repair work, not only after code lands.
- Validate auto-recovery / observability behavior, not only happy-path correctness.

### Add protocol

- Build test coverage directly from RCA itemization and repair task IDs.
- Record pass/fail with evidence and exact task/fix lane linkage.

## Help-Agent / Supervisor

### Add responsibilities

- Provide coordination continuity during Master absence.
- Detect stalled repair chains where build or QA ownership is missing.

### Add protocol

- When triggered by `@help`, decide whether the situation is:
  - blocker assistance
  - routing gap
  - coordinator outage
- If it is a routing gap or coordinator outage, act visibly on the board.

---

## Recommended rollout order

### Immediate

1. Update incident task templates to require:
   - validation scope
   - changed files
   - checkpoint / handoff note
2. Give QA a standing expectation to prepare regression matrices early on incident tasks.
3. Treat `tsc_check` as the default type-check path for repair work.

### Near-term

4. Update Master / Builder / QA / Help-Agent genome text with the protocol additions above.
5. Add coordinator guidance for `humanStatusLock` handling.
6. Add per-team active-Claude cap guidance and spawn staggering guidance.

### Follow-up

7. Add runtime metrics / warnings for:
   - auto-compact ineligible sessions
   - active Claude concurrency above cap
   - sessions above 70% / 85% context without a recent checkpoint

---

## Proposed acceptance criteria for this policy package

- Incident tasks contain visible context / validation / handoff checkpoints.
- Builders are no longer losing large uncommitted slices.
- QA starts from RCA/task lanes instead of waiting for an amorphous “done”.
- Master absence no longer stalls the board.
- Teams avoid unsafe Claude fanout by default.
- Non-compactable sessions are visible and auditable.
