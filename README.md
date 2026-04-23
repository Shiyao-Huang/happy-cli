# Aha CLI

> Control Claude Code from your mobile device. Run multi-agent teams. Code anywhere.

Free. Open source. MIT licensed.

## Architecture

```
Mobile / Browser          Aha Server              Local Machine
─────────────────         ──────────────          ──────────────────────
 Web App (UI)   ◄────►   WebSocket / E2E  ◄────►  aha daemon
 iOS / Android           Encrypted relay           └─ Claude Code sessions
                                                   └─ Multi-agent teams
```

All traffic is end-to-end encrypted with TweetNaCl before leaving your device. The Aha server relays encrypted bytes only — it never sees your code or prompts.

## Quick Start

### 1. Install

```bash
npm install -g aha-agi
```

### 2. Start the Daemon

```bash
aha daemon start
```

### 3. Open Web App

Visit **https://aha-agi.com/webappv3** in your browser or mobile device.

## Features

- **Code Anywhere**: Control Claude Code from mobile, tablet, or any browser
- **Multi-Agent Teams**: Built-in support for specialized roles (Master, Builder, Architect, QA, etc.)
- **End-to-End Encryption**: All communications encrypted with TweetNaCl
- **Real-time Sync**: Instant session sharing across all your devices
- **Open Source**: MIT licensed

## Commands

| Command | Description |
|---------|-------------|
| `aha` | Start a Claude Code session with QR code |
| `aha daemon start` | Start the background daemon |
| `aha daemon stop` | Stop the daemon |
| `aha daemon status` | Check daemon status |
| `aha auth` | Manage authentication |
| `aha auth reconnect` | Refresh cached account |
| `aha auth login --code <key>` | Restore account from backup key |
| `aha auth join --ticket <ticket>` | Join existing account |
| `aha codex` | Start Codex mode |
| `aha connect` | Store AI vendor API keys in Aha cloud |
| `aha notify` | Send push notification to devices |
| `aha doctor` | System diagnostics & troubleshooting |

## Options

| Flag | Description |
|------|-------------|
| `-h, --help` | Show help |
| `-v, --version` | Show version |
| `-m, --model <model>` | Claude model (default: sonnet) |
| `-p, --permission-mode <mode>` | Permission mode: auto, default, or plan |
| `--claude-env KEY=VALUE` | Set env variable for Claude Code |
| `--claude-arg ARG` | Pass additional argument to Claude CLI |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AHA_HOME_DIR` | `~/.aha` | Data directory |
| `AHA_SERVER_URL` | `https://aha-agi.com/api` | Server URL |
| `AHA_WEBAPP_URL` | `https://aha-agi.com/webappv3` | Web app URL |
| `AHA_CONFIG_FILE` | `~/.aha/config.json` | Config file path |
| `AHA_DISABLE_CAFFEINATE` | — | Set to `true` to disable macOS sleep prevention |
| `AHA_EXPERIMENTAL` | — | Set to `true` to enable experimental features |

Persistent config can also live in `~/.aha/config.json`:

```json
{
  "serverUrl": "http://localhost:3005",
  "webappUrl": "http://localhost:8081"
}
```

## Development Setup

### Requirements

- Node.js >= 22.0.0
- Claude CLI installed and logged in (`claude` command in PATH)
- Yarn 4.x

### Local Development

```bash
# Clone the repo
git clone https://github.com/Shiyao-Huang/happy-cli.git
cd aha-cli

# Install dependencies
yarn install

# Build
yarn build

# Run locally (points to production server by default)
./bin/aha.mjs daemon start

# Run against a local server
AHA_SERVER_URL=http://localhost:3005 ./bin/aha.mjs daemon start
```

### Running Tests

```bash
# Unit tests (excludes E2E)
yarn test

# Type checking
yarn typecheck

# Lint
yarn lint
```

### Daemon Logs

Logs are stored in `~/.aha/logs/` (or `$AHA_HOME_DIR/logs/`):

```bash
# View daemon logs
tail -f ~/.aha/logs/*-daemon.log

# View session logs
tail -f ~/.aha/logs/2026-01-17-12-49-59-pid-20555.log
```

## Third-Party Notices

Aha CLI depends on `@anthropic-ai/claude-code`, which is proprietary software owned by Anthropic and distributed under its own license terms. By using Aha CLI, you agree to comply with [Anthropic's usage policies](https://www.anthropic.com/legal/aup) and the terms governing the Claude Code SDK.

All other production dependencies are MIT, ISC, Apache-2.0, or Unlicense — fully compatible with this project's MIT license.

## Documentation

- **[Auth Quickstart](./docs/auth-quickstart.md)** - Reconnect, restore, and new-account flows
- **[Auth Recovery](./docs/auth-recovery-account-consistency.md)** - Restore-key recovery and account consistency
- **[CHANGELOG](./CHANGELOG.md)** - Release notes
- **[Contributing Guide](./CONTRIBUTING.md)** - How to contribute
- **[Security Policy](./SECURITY.md)** - Reporting vulnerabilities
- **[Code of Conduct](./CODE_OF_CONDUCT.md)** - Community standards

## License

MIT — see [LICENSE](./LICENSE)

## Contact

- **Issues**: [GitHub Issues](https://github.com/Shiyao-Huang/happy-cli/issues/new/choose)
- **Discussions**: [GitHub Discussions](https://github.com/Shiyao-Huang/happy-cli/discussions)
