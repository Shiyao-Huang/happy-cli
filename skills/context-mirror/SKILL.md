# /context-mirror

Use this skill when you need to inspect your own context usage and decide whether to compact.

---

## Goal

Turn vague “I might be getting full” feelings into one quick check plus one clear action.

## Workflow

1. Call `get_context_status()`.
2. Read:
   - `currentContextK`
   - `usedPercent`
   - `status`
   - `recommendation`
3. Decide:
   - `usedPercent < 70` → keep working
   - `70 <= usedPercent < 85` → finish the current subtask, then `/compact`
   - `usedPercent >= 85` → `/compact` immediately

## When to use it

- At the start of a large task
- After loading many files or logs
- Before writing a long summary / review / design note
- Any time performance feels degraded

## Compact rule of thumb

Prefer compacting **between** subtasks, not in the middle of one — unless the status is critical.
