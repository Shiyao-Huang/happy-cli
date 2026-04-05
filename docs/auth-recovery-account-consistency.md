# Auth Recovery & Account Consistency

> For local operators, AI agents, and anyone debugging "daemon is online but the board cannot see the machine".

---

## Core Model

In Aha v3, these objects are all account-scoped:

- `Account`
- `Machine`
- `Session`
- `Team`
- `Artifact`

The local CLI stores exactly one active credential set in:

- `~/.aha-v3/access.key`

That file is a **single-slot cache** for the current identity. If a later auth flow succeeds against a different account, the new identity replaces the old one.

This means:

- A running daemon can be healthy
- The machine can be correctly registered
- The web board can still fail to see that machine

If the machine belongs to **Account B** while the team/artifacts belong to **Account A**.

---

## Typical Failure Pattern

Symptoms:

- `aha-v3 doctor` says the daemon is running
- `aha-v3 auth login` says you are authenticated
- The board shows no online machine
- `@help` appears to do nothing

Most common root cause:

- The browser / board is using one account
- The local daemon / machine is using another account

This is not a daemon-start failure. It is an **account consistency** failure.

---

## First Checks

Run these locally:

```bash
cd /path/to/aha-cli
fnm use 22
aha-v3 doctor
aha-v3 auth status
```

Confirm:

- current `machineId`
- daemon is running
- `serverUrl` points where you expect
- current data directory is `~/.aha-v3`

Then compare with the web board:

- does the team live under the same account?
- does the machine list show the same machine id?

If not, you have an account split.

---

## Recovery Paths

### 1. Reconnect Existing Account

Use this only when local credentials are already correct and you just need a fresh token:

```bash
aha-v3 auth reconnect
```

This path attempts a reconnect using the currently cached credential material.

### 2. Restore From Backup Key

Use this when the local cache has drifted to the wrong account, or when you explicitly want to return to a known identity.

If you have a downloaded restore key JSON like:

```text
/Users/<you>/Downloads/aha-restore-key-YYYYMMDD-HHMMSS.json
```

Open it and copy the `secretKeyFormatted` value, then run:

```bash
aha-v3 auth login --code XXXXX-XXXXX-XXXXX-XXXXX
```

This does four important things:

1. Restores credentials for the account behind that key
2. Clears the local `machineId`
3. Stops the old daemon
4. Starts a new daemon and re-registers the machine under the restored account

This is the safest path when team data and machine data have split across accounts.

### 3. Force New Account

Only use this when you intentionally want a fresh identity:

```bash
aha-v3 auth login --force
```

This clears credentials and machine identity before opening a new auth flow.

---

## Recommended Recovery Procedure

If your daemon is online but the board cannot see the machine:

1. Stop guessing. Do not keep clicking browser reconnect.
2. Use the backup key for the account that owns the team data:

```bash
cd /path/to/aha-cli
fnm use 22
aha-v3 auth login --code <secretKeyFormatted-from-backup-json>
```

3. Verify:

```bash
aha-v3 auth status
aha-v3 doctor
```

4. Refresh the board and check whether the machine now appears.

If the team and machine still do not align, inspect account ownership in the server database rather than retrying auth blindly.

---

## Why This Happens

The CLI does have reconnect/restore paths, but the default auth surface still mixes several behaviors:

- authenticate
- reconnect
- restore
- create new account

So if the wrong auth path is taken, the local single-slot cache can end up pointing at a different account than the one your teams already use.

The issue is not "missing cache". The issue is:

- **single active identity cache**
- **insufficient account continuity guardrails**

---

## What AI Should Infer

When investigating auth/daemon problems, use these rules:

1. If daemon is running, do **not** conclude "daemon failed to start".
2. If board cannot see the machine, check **account consistency** before checking process health.
3. Treat `~/.aha-v3/access.key` as the current identity cache, not a history of identities.
4. If the wrong account is cached, prefer **backup-key restore** over browser reconnect.
5. Do not assume messages, teams, and machines automatically belong to the same account just because they are on the same local server.

---

## Related Docs

- [Aha CLI v3 Reference](./aha-v3-cli-reference.md)
- [Getting Started](../GETTING_STARTED.md)
