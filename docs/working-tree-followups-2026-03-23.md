# Working Tree Follow-ups — 2026-03-23

- Restart the local daemon after deploying this branch so the recovered-session API wiring and `channels` bridge handlers are loaded by the live tool registry.
- Verify the WeChat iLink Bot flow end to end with real credentials: `aha channels weixin login`, push policy changes, and inbound command routing.
- Full `yarn typecheck` needs one clean rerun in a fresh shell. Targeted tests for the new publication and recovery changes passed.
