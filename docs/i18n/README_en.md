# Happy (Happy CLI)

> **Code on the go** - Control Claude Code from anywhere with your mobile device

**Happy** is a powerful CLI tool that wraps Claude Code to enable remote control and session sharing. Control Claude directly from your mobile device, monitor token usage in real-time, and manage multiple AI models seamlessly.

[![MIT License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20+-green.svg)](https://nodejs.org/)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-2.0+-orange.svg)](https://docs.anthropic.com/en/docs/claude-code/overview)

---

## Features

### 🚀 Core Functionality
- **Mobile Control** - Control Claude from your phone/tablet via secure WebSocket connection
- **Session Sharing** - Share and sync sessions across devices
- **QR Code Authentication** - Quick secure pairing with mobile app
- **Real-time Messaging** - Live interaction between CLI and mobile

### 📊 Token Monitoring & Analytics
- **Real-time Token Tracking** - Monitor usage as it happens
- **Cost Calculation** - Track exact costs per request and session
- **Rate Statistics** - See tokens/second and cost/second
- **Usage History** - Persistent storage with JSONL format
- **Model Breakdown** - Usage statistics by AI model

### 🤖 Model Management
- **Multiple AI Providers** - Claude, MiniMax, GLM, Kimi, and more
- **Dynamic Switching** - Change models without code changes
- **Auto-switching** - Smart model selection based on cost/performance
- **Model Profiles** - Custom configurations with tags and cost tracking
- **Export/Import** - Share model configurations

### 📈 Live Dashboard
- **Terminal UI** - Beautiful real-time visualization
- **Rate Indicators** - Visual bars showing current usage
- **Model Rankings** - See top models by usage
- **Activity Log** - Recent request history

---

## Installation

```bash
# Install globally
npm install -g happy-coder

# Verify installation
happy --version
```

**Requirements:**
- Node.js >= 20.0.0
- Claude CLI installed & authenticated
- Mobile device with Happy app (iOS/Android)

---

## Quick Start

### 1. Start a Session
```bash
# Basic usage - starts Claude with mobile control
happy

# Or use any Claude options
happy --yolo --model claude-3-5-sonnet "Analyze this code"
```

### 2. Monitor Token Usage
```bash
# View real-time token statistics
happy --stats

# Start live dashboard
happy --dashboard

# Watch mode (updates every 2 seconds)
happy --stats --watch
```

### 3. Manage Models
```bash
# List all available models
happy --seeall

# Switch to a different model
happy --to claude-3-5-haiku

# View current model
happy --to

# Auto-switch based on cost
happy --auto cheap  # Switch to cheaper model
happy --auto expensive  # Switch to more capable model
```

---

## Command Reference

### Core Commands
| Command | Description |
|---------|-------------|
| `happy` | Start Claude session with mobile control |
| `happy auth` | Manage authentication & API keys |
| `happy codex` | Start Codex mode |
| `happy connect` | Store AI vendor API keys |
| `happy notify` | Send push notifications |
| `happy daemon` | Manage background service |
| `happy doctor` | System diagnostics |

### Token Monitoring
| Command | Description |
|---------|-------------|
| `happy --stats` | View token usage statistics |
| `happy --stats --format json` | JSON output |
| `happy --stats --format compact` | Compact view |
| `happy --stats --watch` | Real-time monitoring |
| `happy --stats --model claude-3-5-sonnet` | Filter by model |

### Model Management
| Command | Description |
|---------|-------------|
| `happy --seeall` | List all models |
| `happy --to <model>` | Switch model |
| `happy --to` | Show current model |
| `happy --toadd <name>` | Add custom model |
| `happy --del <name>` | Remove model |
| `happy --auto <pattern>` | Auto-switch (cheap/expensive/balanced) |
| `happy --exp <file>` | Export config |
| `happy --imp <file>` | Import config |

### Dashboard
| Command | Description |
|---------|-------------|
| `happy --dashboard` | Start real-time dashboard |
| `happy --dashboard --refresh 500` | Custom refresh rate |

---

## Advanced Usage

### Model Profiles

Create custom model configurations:

```bash
# Add a model with custom pricing
happy --toadd my-model \
  --model claude-3-5-sonnet \
  --cost "0.003:0.015" \
  --tags "reasoning,fast"
```

Model profiles are stored in `~/.happy/model-config.json`:
```json
{
  "profiles": {
    "claude-3-5-sonnet": {
      "name": "claude-3-5-sonnet",
      "displayName": "Claude 3.5 Sonnet",
      "provider": "anthropic",
      "modelId": "claude-3-5-sonnet-20241022",
      "costPer1KInput": 0.003,
      "costPer1KOutput": 0.015,
      "tags": ["reasoning", "coding"],
      "isActive": true
    }
  }
}
```

### Token Usage Tracking

Monitor token usage in your code:

```typescript
import { createMonitoredQuery } from '@/claude/sdk'

const { query, tokenMonitor } = createMonitoredQuery({
    prompt: 'Your prompt here',
    options: { model: 'claude-3-5-sonnet' }
})

for await (const message of query) {
    // Process messages
}

// Get statistics
const stats = tokenMonitor.getStats()
console.log(`Total cost: $${stats.totalCost}`)
```

### Real-time Event Listeners

```typescript
import { getTokenMonitor } from '@/claude/sdk'

const monitor = getTokenMonitor()

// Listen for usage events
monitor.on('usage', (usage) => {
    console.log(`New request: ${usage.totalTokens} tokens`)
})

// Listen for rate changes
monitor.on('stats', (stats) => {
    console.log(`Current rate: ${stats.currentRate.tokensPerSecond} t/s`)
})
```

---

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `HAPPY_SERVER_URL` | Custom server URL | https://api.cluster-fluster.com |
| `HAPPY_WEBAPP_URL` | Custom web app URL | https://app.happy.engineering |
| `HAPPY_HOME_DIR` | Data directory | ~/.happy |
| `HAPPY_DISABLE_CAFFEINATE` | Disable macOS sleep prevention | false |
| `HAPPY_EXPERIMENTAL` | Enable experimental features | false |

### Configuration Files

- `~/.happy/model-config.json` - Model profiles and settings
- `~/.happy/token-usage.json` - Token usage history (JSONL)
- `~/.happy/credentials` - Authentication credentials
- `~/.happy/logs/` - Application logs

---

## API Providers

Happy supports multiple AI providers:

| Provider | Model Examples | Notes |
|----------|----------------|-------|
| **Anthropic** | claude-3-5-sonnet, claude-3-5-haiku | Primary provider |
| **MiniMax** | MM-1.0, MM-1.5 | Chat/Completion models |
| **GLM** | glm-4.6, glm-4-plus | By Zhipu AI |
| **Kimi** | KIMI/kimi | Moonshot AI |

Add custom providers:
```bash
happy --toadd custom \
  --model your-model-id \
  --cost "input:output" \
  --provider custom
```

---

## Documentation

📚 **Additional Documentation:**
- [Token Monitoring Guide](./TOKEN_MONITORING.md) - Complete API reference
- [Getting Started Guide](./GETTING_STARTED.md) - Quick start tutorial
- [CLI Integration Guide](./CLI_INTEGRATION.md) - Advanced usage
- [Implementation Summary](./IMPLEMENTATION_SUMMARY.md) - Technical details
- [Roadmap](./roadmap.md) - Future features

---

## Troubleshooting

### Common Issues

**Module not found error**
```bash
# Solution: Compile the project
npm run build
```

**Daemon not running**
```bash
# Start the background service
happy daemon start
```

**Permission denied**
```bash
# Check authentication
happy auth status
```

Run diagnostics:
```bash
happy doctor
```

---

## Development

### Project Structure
```
src/
├── index.ts                 # CLI entry point
├── api/                     # API client & authentication
├── claude/                  # Claude Code integration
│   ├── loop.ts             # Control loop
│   └── sdk/                # SDK integration
├── commands/               # Command implementations
│   ├── token-stats.ts     # Token monitoring
│   ├── model-switch.ts    # Model management
│   └── dashboard.ts       # Real-time dashboard
└── ui/                     # User interface
```

### Build
```bash
npm run build    # Compile TypeScript
npm run watch    # Watch mode
npm test         # Run tests
```

---

## License

MIT License - see [LICENSE](LICENSE) for details

---

## Support

- 📧 Email: support@happy.engineering
- 🐛 Issues: [GitHub Issues](https://github.com/slopus/happy-cli/issues)
- 💬 Discord: [Join our community](https://discord.gg/happy)
- 📖 Docs: [docs.happy.engineering](https://docs.happy.engineering)
