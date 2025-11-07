# Happy CLI

Mobile and Web client for Claude Code with powerful features including model management, token monitoring, and real-time session control.

Free. Open source. Code anywhere.

## Installation

```bash
npm install -g happy-coder
```

## Quick Start

```bash
happy
```

This will:
1. Start a Claude Code session with mobile control enabled
2. Display a QR code to connect from your mobile device
3. Allow real-time session sharing between Claude Code and your mobile app
4. Enable advanced features like model switching and token monitoring

## Main Commands

### Session Control
- `happy` - Start a new Claude session with mobile control
- `happy --resume` - Resume a previous session
- `happy --yolo` - Start session with permission bypass for automation
- `happy --to <model>` - Switch to a specific model (e.g., claude-3-5-haiku)
- `happy --yolo --to <model>` - Switch model and start session (e.g., GLM)

### Model Management
- `happy --seeall` - List all available models
- `happy --toadd <name>` - Add a new model profile
- `happy --del <name>` - Remove a model profile
- `happy --upd <name>` - Update a model profile
- `happy --auto <pattern>` - Auto-switch model (expensive|cheap|balanced)
- `happy --exp <file>` - Export model configuration
- `happy --imp <file>` - Import model configuration

### Token Monitoring
- `happy --stats` - View daily token usage
- `happy --watch` - Real-time token monitoring
- `happy --f compact` - Compact output format
- `happy --f table` - Table output format
- `happy --f json` - JSON output format
- `happy daily` - Group statistics by day
- `happy weekly` - Group statistics by week
- `happy monthly` - Group statistics by month
- `happy --since 20240101` - Filter from date
- `happy --until 20241231` - Filter until date

### Dashboard
- `happy --dashboard` - Open real-time monitoring dashboard

### Utility Commands
- `happy auth` – Manage authentication and machine setup
- `happy auth login` – Authenticate with the service
- `happy auth logout` – Remove authentication credentials
- `happy connect` – Connect AI vendor API keys to Happy cloud
- `happy notify -p "message"` – Send push notification to your devices
- `happy codex` – Start Codex mode (MCP bridge)
- `happy daemon` – Manage background service
- `happy doctor` – System diagnostics & troubleshooting
- `happy doctor clean` – Clean up runaway processes

### Daemon Management
- `happy daemon start` – Start the background daemon
- `happy daemon stop` – Stop the daemon (sessions stay alive)
- `happy daemon status` – Show daemon status
- `happy daemon list` – List active sessions
- `happy daemon stop-session <id>` – Stop a specific session
- `happy daemon logs` – Show daemon log file path
- `happy daemon install` – Install daemon service
- `happy daemon uninstall` – Remove daemon service

## Options

### General Options
- `-h, --help` - Show help
- `-v, --version` - Show version
- `--started-by <mode>` - Started by (daemon|terminal)
- `--happy-starting-mode <mode>` - Starting mode (local|remote)

### Model & Permission Options
- `-m, --model <model>` - Claude model to use (default: sonnet)
- `-p, --permission-mode <mode>` - Permission mode: auto, default, or plan
- `--yolo` - Bypass all permissions (dangerous)
- `--dangerously-skip-permissions` - Skip permission checks (same as --yolo)

### Claude Integration
- `--claude-env KEY=VALUE` - Set environment variable for Claude Code
- `--claude-arg ARG` - Pass additional argument to Claude CLI
- `--resume` - Resume a previous session
- **Happy supports ALL Claude options!** - Use any claude flag with happy as you would with claude

## Environment Variables

### Server Configuration
- `HAPPY_SERVER_URL` - Custom server URL (default: https://api.happy-servers.com)
- `HAPPY_WEBAPP_URL` - Custom web app URL (default: https://app.happy.engineering)
- `HAPPY_HOME_DIR` - Custom home directory for Happy data (default: ~/.happy)

### System
- `HAPPY_DISABLE_CAFFEINATE` - Disable macOS sleep prevention (set to `true`, `1`, or `yes`)
- `HAPPY_EXPERIMENTAL` - Enable experimental features (set to `true`, `1`, or `yes`)

### Claude Integration
- `ANTHROPIC_DEFAULT_SONNET_MODEL` - Override default Sonnet model
- `ANTHROPIC_MODEL` - Set default Claude model
- `ANTHROPIC_BASE_URL` - Custom Anthropic API base URL
- `ANTHROPIC_AUTH_TOKEN` - Anthropic API authentication token

## Examples

### Start a Session
```bash
happy                          # Start new session
happy --resume                 # Resume previous session
happy --yolo                   # Start with permission bypass
```

### Model Management
```bash
happy --to claude-3-5-haiku    # Switch to Haiku model
happy --yolo --to GLM          # Switch to GLM and start
happy --seeall                 # List all available models
happy --toadd my-model         # Add custom model
```

### Token Monitoring
```bash
happy --stats                  # View daily token usage
happy --watch                  # Real-time monitoring
happy --stats -f compact       # Compact format
happy --stats weekly           # Group by week
happy --stats --since 20240101 --until 20241231  # Date range
```

### Advanced
```bash
happy --dashboard              # Open real-time dashboard
happy auth login --force       # Re-authenticate
happy notify -p "Test"         # Send notification
happy daemon status            # Check daemon
happy doctor                   # Run diagnostics
```

## Requirements

- **Node.js >= 20.0.0**
  - Required by `eventsource-parser@3.0.5`, which is required by
  `@modelcontextprotocol/sdk`, used for permission forwarding
- **Claude CLI installed & logged in** (`claude` command available in PATH)

## Architecture

Happy CLI is part of a three-component system:

1. **Happy CLI** (this project) - Command-line interface wrapping Claude Code
2. **Happy** - React Native mobile client
3. **Happy Server** - Node.js server with Prisma (hosted at https://api.happy-servers.com/)

### Key Features

- **Dual-mode operation**: Interactive (terminal) and remote (mobile control)
- **End-to-end encryption**: All communications encrypted using TweetNaCl
- **Session persistence**: Resume sessions across restarts
- **Model management**: Switch between different Claude models with profiles
- **Token monitoring**: Real-time tracking and historical statistics
- **Daemon architecture**: Background service manages sessions
- **Permission forwarding**: Mobile app approves/rejects Claude permissions

## License

MIT
