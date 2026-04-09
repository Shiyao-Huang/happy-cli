# Aha

Code on the go controlling claude code from your mobile device.

Free. Open source. Code anywhere.

## 🚀 Quick Start

### 1. Install

```bash
npm install -g cc-aha-cli-v3
```

> **Note:** This v3 package intentionally uses the versioned `aha-v3` binary (with `kanban-v3` as an alias) and stores data under `~/.aha-v3`, so it can coexist with the legacy `cc-aha-cli` package.

### 2. Start the Daemon

```bash
aha-v3 daemon start
```

### 3. Open Web App

Visit **https://top1vibe.com/webappv2** in your browser or mobile device to:
- Control Claude Code remotely from any device
- Create multi-agent teams (Master, Builder, QA, etc.)
- **No local configuration needed** - enjoy full team collaboration out of the box!

## ✨ Features

- 🌍 **Code Anywhere**: Control Claude Code from mobile, tablet, or any browser
- 🤝 **Multi-Agent Teams**: Built-in support for 22 specialized roles (Master, Builder, Architect, QA, etc.)
- 🔒 **End-to-End Encryption**: All communications are encrypted with TweetNaCl
- 🔄 **Real-time Sync**: Instant session sharing across all your devices
- 📱 **Mobile First**: Optimized for mobile coding experience
- 🆓 **Free & Open Source**: MIT licensed

## Basic Usage

```bash
aha-v3
```

This will:
1. Start a Claude Code session
2. Display a QR code to connect from your mobile device
3. Allow real-time session sharing between Claude Code and your mobile app

## Commands

- `aha-v3 auth` – Manage authentication
  - `aha-v3 auth reconnect` refreshes the currently cached account
  - `aha-v3 auth login --code <backup-key>` restores a known account from a one-time ticket
  - `aha-v3 auth join --ticket <ticket>` joins an existing account from a join link
- `aha-v3 codex` – Start Codex mode
- `aha-v3 connect` – Store AI vendor API keys in Aha cloud
- `aha-v3 notify` – Send a push notification to your devices
- `aha-v3 daemon` – Manage background service
- `aha-v3 doctor` – System diagnostics & troubleshooting

## Daemon

The daemon is a background service that enables remote control from the mobile app and handles team session spawning.

### Starting the Daemon

```bash
# Start daemon with default server
aha-v3 daemon start

# Start daemon with custom server URL (for local development)
AHA_SERVER_URL=http://localhost:3005 aha-v3 daemon start

# Check daemon status
aha-v3 daemon status

# Stop daemon
aha-v3 daemon stop
```

### Daemon for Teams

**Important**: The daemon must be running to create teams with auto-spawned agent sessions. When you create a team in the mobile app with spawned agents (e.g., Master, Builder, Framer), the daemon:

1. Receives the spawn request from the mobile app
2. Creates new Claude sessions with `teamId` and `role` in their metadata
3. Sets environment variables (`AHA_ROOM_ID`, `AHA_AGENT_ROLE`) for team context
4. Manages the lifecycle of spawned sessions

### Daemon Logs

Daemon logs are stored in `~/.aha-v3/logs/` (or `$AHA_HOME_DIR/logs/`):
- Format: `YYYY-MM-DD-HH-MM-SS-pid-PID-daemon.log`
- Session logs: `YYYY-MM-DD-HH-MM-SS-pid-PID.log`

View logs for debugging:
```bash
# View daemon logs
tail -f ~/.aha-v3/logs/*-daemon.log

# View specific session logs
tail -f ~/.aha-v3/logs/2026-01-17-12-49-59-pid-20555.log
```

## Options

- `-h, --help` - Show help
- `-v, --version` - Show version
- `-m, --model <model>` - Claude model to use (default: sonnet)
- `-p, --permission-mode <mode>` - Permission mode: auto, default, or plan
- `--claude-env KEY=VALUE` - Set environment variable for Claude Code
- `--claude-arg ARG` - Pass additional argument to Claude CLI

## Environment Variables

- `AHA_SERVER_URL` - Custom server URL (default: https://top1vibe.com/api/v2)
- `AHA_WEBAPP_URL` - Custom web app URL (default: https://top1vibe.com/webappv2)
- `AHA_HOME_DIR` - Custom home directory for Aha data (default: ~/.aha-v3)
- `AHA_CONFIG_FILE` - Path to persistent CLI config JSON. Environment variables still take priority.
- `AHA_DISABLE_CAFFEINATE` - Disable macOS sleep prevention (set to `true`, `1`, or `yes`)
- `AHA_EXPERIMENTAL` - Enable experimental features (set to `true`, `1`, or `yes`)

Persistent config can also live in `~/.aha-v3/config.json`:

```json
{
  "serverUrl": "http://localhost:3005",
  "webappUrl": "http://localhost:8081"
}
```

## Requirements

- Node.js >= 22.0.0
  - Required by `eventsource-parser@3.0.5`, which is required by
  `@modelcontextprotocol/sdk`, which we used to implement permission forwarding
  to mobile app
- Claude CLI installed & logged in (`claude` command available in PATH)

## 📚 Documentation

- **[CLI v3 Reference](./docs/aha-v3-cli-reference.md)** - Complete command syntax, workflows, and configuration reference
- **[Auth Quickstart](./docs/auth-quickstart.md)** - Shortest path for reconnect, restore, and new-account flows
- **[Auth Recovery & Account Consistency](./docs/auth-recovery-account-consistency.md)** - Restore-key recovery, reconnect semantics, and machine/team account mismatch diagnosis
- **[CHANGELOG](./CHANGELOG.md)** - Release notes for npm package versions
- **[Contributing Guide](./CONTRIBUTING.md)** - How to contribute to Aha development
- **[Security Policy](./SECURITY.md)** - How to report security vulnerabilities
- **[Code of Conduct](./CODE_OF_CONDUCT.md)** - Community standards

## 📞 Contact & Support

Need help or want to contribute? Reach out to us:

- **Email**: hsy863551305@gmail.com
- **WeChat**: CopizzaH (add with note "Aha User")
- **Issues**: [GitHub Issues](https://github.com/slopus/aha-cli/issues)
- **Discussions**: [GitHub Discussions](https://github.com/slopus/aha-cli/discussions)

We're here to help you get the most out of Aha!

## License

MIT
