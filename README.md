# Aha

Code on the go controlling claude code from your mobile device.

Free. Open source. Code anywhere.

## 🚀 Quick Start

### 1. Install

```bash
npm install -g cc-aha-cli
```

> **Note:** The package name is `cc-aha-cli`, but the command you use is still `aha`. Nothing changes for end users!

### 2. Start the Daemon

```bash
aha daemon start
```

### 3. Open Web App

Visit **https://top1vibe.com/webapp** in your browser or mobile device to:
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
aha
```

This will:
1. Start a Claude Code session
2. Display a QR code to connect from your mobile device
3. Allow real-time session sharing between Claude Code and your mobile app

## Commands

- `aha auth` – Manage authentication
- `aha codex` – Start Codex mode
- `aha connect` – Store AI vendor API keys in Aha cloud
- `aha notify` – Send a push notification to your devices
- `aha daemon` – Manage background service
- `aha doctor` – System diagnostics & troubleshooting

## Daemon

The daemon is a background service that enables remote control from the mobile app and handles team session spawning.

### Starting the Daemon

```bash
# Start daemon with default server
./bin/aha.mjs daemon start

# Start daemon with custom server URL (for local development)
AHA_SERVER_URL=http://localhost:3005 ./bin/aha.mjs daemon start

# Check daemon status
./bin/aha.mjs daemon status

# Stop daemon
./bin/aha.mjs daemon stop
```

### Daemon for Teams

**Important**: The daemon must be running to create teams with auto-spawned agent sessions. When you create a team in the mobile app with spawned agents (e.g., Master, Builder, Framer), the daemon:

1. Receives the spawn request from the mobile app
2. Creates new Claude sessions with `teamId` and `role` in their metadata
3. Sets environment variables (`AHA_ROOM_ID`, `AHA_AGENT_ROLE`) for team context
4. Manages the lifecycle of spawned sessions

### Daemon Logs

Daemon logs are stored in `~/.aha/logs/` (or `$AHA_HOME_DIR/logs/`):
- Format: `YYYY-MM-DD-HH-MM-SS-pid-PID-daemon.log`
- Session logs: `YYYY-MM-DD-HH-MM-SS-pid-PID.log`

View logs for debugging:
```bash
# View daemon logs
tail -f ~/.aha/logs/*-daemon.log

# View specific session logs
tail -f ~/.aha/logs/2026-01-17-12-49-59-pid-20555.log
```

## Options

- `-h, --help` - Show help
- `-v, --version` - Show version
- `-m, --model <model>` - Claude model to use (default: sonnet)
- `-p, --permission-mode <mode>` - Permission mode: auto, default, or plan
- `--claude-env KEY=VALUE` - Set environment variable for Claude Code
- `--claude-arg ARG` - Pass additional argument to Claude CLI

## Environment Variables

- `AHA_SERVER_URL` - Custom server URL (default: https://top1vibe.com)
- `AHA_WEBAPP_URL` - Custom web app URL (default: https://app.aha.engineering)
- `AHA_HOME_DIR` - Custom home directory for Aha data (default: ~/.aha)
- `AHA_DISABLE_CAFFEINATE` - Disable macOS sleep prevention (set to `true`, `1`, or `yes`)
- `AHA_EXPERIMENTAL` - Enable experimental features (set to `true`, `1`, or `yes`)

## Requirements

- Node.js >= 20.0.0
  - Required by `eventsource-parser@3.0.5`, which is required by
  `@modelcontextprotocol/sdk`, which we used to implement permission forwarding
  to mobile app
- Claude CLI installed & logged in (`claude` command available in PATH)

## 📚 Documentation

- **[Getting Started Guide](./GETTING_STARTED.md)** - Comprehensive guide with use cases and examples
- **[Contributing Guide](./CONTRIBUTING.md)** - How to contribute to Aha development
- **[Promotion Materials](./PROMOTION.md)** - Help spread the word about Aha

## 📞 Contact & Support

Need help or want to contribute? Reach out to us:

- **Email**: hsy863551305@gmail.com
- **WeChat**: CopizzaH (add with note "Aha User")
- **Issues**: [GitHub Issues](https://github.com/slopus/aha-cli/issues)
- **Discussions**: [GitHub Discussions](https://github.com/slopus/aha-cli/discussions)

We're here to help you get the most out of Aha!

## License

MIT
