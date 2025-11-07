# Happy (Happy CLI)

[English](./docs/i18n/README_en.md) | [中文](./docs/i18n/README_zh.md) | [日本語](./docs/i18n/README_ja.md) | [한국어](./docs/i18n/README_ko.md)

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

# Switch model and run in one command
happy --yolo --to GLM

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
| `happy --yolo --to <model>` | Switch model and run in one command |
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

## Security Configuration

### 🔒 API Key Management

**Happy CLI prioritizes security - API keys are never hardcoded!**

#### Configuration Files

Create a configuration file at one of these locations:
- `~/.happy/APIs` (recommended)
- `/Users/swmt/Documents/auto_claude_proxy/APIs` (project-specific)
- `./APIs` (current directory)

#### Setup Example

1. **Copy the template:**
```bash
cp examples/API_CONFIG.template ~/.happy/APIs
```

2. **Edit with your API keys:**
```bash
# Replace placeholders with real values
YOUR_MINIMAX_API_KEY_HERE    → eyJhbGciOiJSUzI1Ni...
YOUR_ZHIPU_API_KEY_HERE      → xxxxx.yyyyy.zzzzz
YOUR_MOONSHOT_API_KEY_HERE   → sk-xxxxxxxxxx
```

3. **Set secure permissions:**
```bash
chmod 600 ~/.happy/APIs
```

4. **Test configuration:**
```bash
happy --seeall  # Should show all 12 models
happy --to MM   # Test MiniMax
happy --to GLM  # Test GLM
happy --to KIMI # Test Kimi
```

#### Available Models (12 total)

| Provider | Models | Aliases |
|----------|--------|---------|
| **Built-in** | claude-3-5-sonnet, claude-3-5-haiku, claude-3-opus, gpt-4o, gpt-4o-mini | - |
| **MiniMax** | MiniMax-M2 | MiniMax, MM |
| **GLM** | glm-4.6 | GLM, glm |
| **Kimi** | kimi-k2-thinking | Kimi, KIMI, kimi |

#### Security Best Practices

✅ **DO:**
- Store API keys in configuration files only
- Use `chmod 600` to restrict file permissions
- Keep configuration files out of version control
- Rotate API keys regularly
- Use different keys for development/production

❌ **DON'T:**
- Never hardcode API keys in source code
- Never commit API keys to git
- Never share API keys in chat or forums
- Never use production keys for testing

#### Documentation

📚 **Security Resources:**
- [API Configuration Guide](./API_CONFIGURATION.md) - Complete setup instructions
- [Security Guide](./SECURITY.md) - Best practices & incident response
- [Configuration Example](./examples/api-config-example.md) - Step-by-step guide
- [Security Summary](./SECURITY_DOCUMENTATION_SUMMARY.md) - Overview

---

## Documentation

📚 **Available in Multiple Languages:**

### English
- [Token Monitoring Guide](./TOKEN_MONITORING.md) - Complete API reference
- [Getting Started Guide](./GETTING_STARTED.md) - Quick start tutorial
- [CLI Integration Guide](./CLI_INTEGRATION.md) - Advanced usage
- [Implementation Summary](./IMPLEMENTATION_SUMMARY.md) - Technical details
- [API Configuration Guide](./API_CONFIGURATION.md) - Security setup instructions
- [Security Guide](./SECURITY.md) - Best practices & incident response
- [Roadmap](./roadmap.md) - Future features

### 中文
- [Token 监控指南](./TOKEN_MONITORING.md) - 完整 API 参考
- [快速开始指南](./GETTING_STARTED.md) - 快速入门教程
- [CLI 集成指南](./CLI_INTEGRATION.md) - 高级用法
- [实现总结](./IMPLEMENTATION_SUMMARY.md) - 技术细节
- [API 配置指南](./API_CONFIGURATION.md) - 安全设置说明
- [安全指南](./SECURITY.md) - 最佳实践和事件响应

### 日本語
- [Token 監視ガイド](./docs/i18n/ja/TOKEN_MONITORING.md) - 完全な API リファレンス
- [はじめに](./docs/i18n/ja/GETTING_STARTED.md) - クイックスタートチュートリアル

### 한국어
- [토큰 모니터링 가이드](./docs/i18n/ko/TOKEN_MONITORING.md) - 전체 API 참조
- [시작하기 가이드](./docs/i18n/ko/GETTING_STARTED.md) - 빠른 시작 튜토리얼

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

## Support & Community

- 📧 Email: support@happy.engineering
- 🐛 Issues: [GitHub Issues](https://github.com/slopus/happy-cli/issues)
- 💬 Discord: [Join our community](https://discord.gg/happy)
- 📖 Docs: [docs.happy.engineering](https://docs.happy.engineering)

---

## Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details.

### Internationalization (i18n)

Help us translate Happy into your language! See [docs/i18n/README_i18n.md](./docs/i18n/README_i18n.md) for translation guidelines.

**Current Languages:**
- ✅ English (en)
- ✅ 中文 (zh)
- 🔄 日本語 (ja) - In progress
- 🔄 한국어 (ko) - In progress

Want to add a new language? Check our [i18n Guide](./docs/i18n/README_i18n.md)!
