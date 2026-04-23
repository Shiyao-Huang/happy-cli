# Codex Team Runtime Deployment Notes

## Failure Mode

Team Codex agents can fail before producing any useful output when either of these host-level conditions is present:

- The team/genome model metadata contains an Anthropic model ID such as `claude-sonnet-4-6`.
- The host network resolves `chatgpt.com` to a TUN fake-ip address such as `198.18.0.10`, then the proxy/VPN path drops the TLS handshake.

The first issue surfaces as:

```text
The 'claude-sonnet-4-6' model is not supported when using Codex with a ChatGPT account.
```

The second issue surfaces as repeated `chatgpt.com` TLS or WebSocket failures, for example:

```text
tls handshake eof
```

## Runtime Protections

The Codex runtime now drops Anthropic model overrides before passing a model to Codex CLI. If a model override is `claude-*`, `anthropic/...`, or `anthropic:...`, the runtime omits the override and lets Codex use its configured default model.

When no explicit `HTTPS_PROXY` / `ALL_PROXY` is configured and `chatgpt.com` resolves to the `198.18.0.0/15` fake-ip range, the runtime starts a local CONNECT shim for the Codex child process only. The shim resolves the public `chatgpt.com` A records through DNS-over-HTTPS and preserves the original TLS SNI by proxying the CONNECT tunnel to the resolved IP.

This does not modify system routes, `/etc/hosts`, or global proxy settings.

## Environment Controls

- `AHA_CODEX_DISABLE_NETWORK_SHIM=1` disables the local CONNECT shim.
- `AHA_CODEX_FORCE_NETWORK_SHIM=1` enables the shim even when local DNS does not look like fake-ip mode.
- `AHA_CODEX_CHATGPT_IPS=104.18.32.47,172.64.155.209` pins the shim to known public `chatgpt.com` IPs instead of resolving through DNS-over-HTTPS.

## Deployment Checklist

1. Build and test the CLI package.

```bash
npx vitest run src/codex/__tests__/emitReadyIfIdle.test.ts src/codex/__tests__/codexNetworkProxy.test.ts
```

2. Install the package used by daemon-spawned agents.

```bash
npm install --prefix /Users/copizza /path/to/aha-cli --no-save --ignore-scripts
npm install -g /path/to/aha-cli --ignore-scripts
```

3. Restart the daemon so new team agents use the updated runtime.

```bash
aha daemon stop
aha daemon start
```

4. Spawn a Codex agent and verify the runtime log includes `CodexNetwork` when fake-ip DNS is active.

```text
[CodexNetwork] Enabled local CONNECT shim for chatgpt.com
```

5. Send a small team smoke-test message and verify the agent replies.

```bash
aha teams send <teamId> "@builder Smoke test only: reply with exactly OK and do not run tools."
```
