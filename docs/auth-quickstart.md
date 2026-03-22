# Auth Quickstart

> The shortest possible guide for humans and AI.

## Normal startup

If the local identity is already correct, do not re-auth.

```bash
cd /Users/swmt/happy0313/aha-cli
fnm use 22
aha-v3
```

`aha-v3` should load the cached local identity from `~/.aha-v3/` and start the daemon in the background.

---

## Reconnect the current account

Use this when the local account is already correct and you just need to refresh it.

```bash
aha-v3 auth reconnect
```

---

## Restore the old account from backup key

Use this when the daemon / machine drifted to the wrong account.

```bash
aha-v3 auth restore --code XXXXX-XXXXX-XXXXX-XXXXX
```

This will:

1. Restore the account behind the backup key
2. Clear the current machine id
3. Stop the old daemon
4. Start a new daemon
5. Re-register the machine under the restored account

---

## Create a fresh new account

Only use this when you intentionally want a new identity.

```bash
aha-v3 auth login --force
```

---

## Verify

After any auth change:

```bash
aha-v3 auth status
aha-v3 doctor
```

Check:

- `Account ID`
- `Machine ID`
- `Daemon`
- `Server URL`

If the board still cannot see the machine, the board and daemon are likely on different accounts.

---

## Rule of thumb

- `reconnect` = keep the current account
- `restore` = go back to a known account
- `login --force` = intentionally create/switch to a new account
