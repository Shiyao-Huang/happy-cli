# /context-mirror

Use this skill when you need to orient on your current identity, tool surface, or context usage.

---

## Goal

Turn vague "what am I / what can I do / am I getting full" feelings into one quick check plus one clear action.

## Workflow

1. Call `get_self_view({ section: "overview", format: "json" })`.
2. Read:
   - `identity.design`
   - `runtime.permissionMode`
   - `tools.summary`
   - `gaps`
3. If the question is about tool availability:
   - Call `list_visible_tools()` first
   - Then `explain_tool_access({ tool })` for one specific tool
   - Then `get_effective_permissions()` if you need capability / allowlist / denied / hidden detail
4. If the question is about compaction risk, call `get_context_status()` and read:
   - `currentContextK`
   - `usedPercent`
   - `status`
   - `recommendation`
5. Decide:
   - `usedPercent < 70` → keep working
   - `70 <= usedPercent < 85` → finish the current subtask, then `/compact`
   - `usedPercent >= 85` → `/compact` immediately

## Truth Discipline

- Treat `unknown` as unknown. Do not assume a registered tool is visible.
- Treat `hidden_by_allowlist` as separate from blocked/denied.
- Use overview first, then drill down. Do not start with full dumps unless you already know the section you need.
