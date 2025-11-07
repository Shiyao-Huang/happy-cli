# Happy (Happy CLI)

[English](#english) | [中文](#中文)

## English

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

---

## 中文

> **移动编码** - 随时随地用手机控制 Claude Code

**Happy** 是一个强大的 CLI 工具，它包装 Claude Code 以实现远程控制和会话共享。直接从手机控制 Claude，实时监控 token 使用情况，并无缝管理多个 AI 模型。

---

## 核心功能

### 🚀 主要功能
- **手机控制** - 通过安全 WebSocket 连接从手机/平板控制 Claude
- **会话共享** - 跨设备分享和同步会话
- **二维码认证** - 与移动应用快速安全配对
- **实时消息** - CLI 和移动设备之间的实时交互

### 📊 Token 监控与分析
- **实时追踪** - 实时监控 token 使用情况
- **成本计算** - 追踪每次请求和会话的准确成本
- **速率统计** - 查看 token/秒和成本/秒
- **使用历史** - 持久化存储 (JSONL 格式)
- **模型细分** - 按 AI 模型的使用统计

### 🤖 模型管理
- **多 AI 提供商** - 支持 Claude、MiniMax、GLM、Kimi 等
- **动态切换** - 无需修改代码即可切换模型
- **自动切换** - 基于成本/性能的智能模型选择
- **模型配置** - 带标签和成本追踪的自定义配置
- **导入导出** - 分享模型配置

### 📈 实时仪表板
- **终端界面** - 精美的实时可视化界面
- **速率指示器** - 显示当前使用情况的视觉条形图
- **模型排行** - 查看使用量最高的模型
- **活动日志** - 最近的请求历史

---

## 安装

```bash
# 全局安装
npm install -g happy-coder

# 验证安装
happy --version
```

**系统要求：**
- Node.js >= 20.0.0
- Claude CLI 已安装并认证
- 装有 Happy 应用的移动设备 (iOS/Android)

---

## 快速开始

### 1. 启动会话
```bash
# 基本用法 - 启动带手机控制的 Claude
happy

# 或使用任何 Claude 选项
happy --yolo --model claude-3-5-sonnet "分析这段代码"
```

### 2. 监控 Token 使用
```bash
# 查看实时 token 统计
happy --stats

# 启动实时仪表板
happy --dashboard

# 监控模式（每 2 秒更新）
happy --stats --watch
```

### 3. 管理模型
```bash
# 列出所有可用模型
happy --seeall

# 切换到不同模型
happy --to claude-3-5-haiku

# 查看当前模型
happy --to

# 基于成本自动切换
happy --auto cheap  # 切换到更便宜的模型
happy --auto expensive  # 切换到更强大的模型
```

---

## 命令参考

### 核心命令
| 命令 | 描述 |
|---------|-------------|
| `happy` | 启动带手机控制的 Claude 会话 |
| `happy auth` | 管理认证和 API 密钥 |
| `happy codex` | 启动 Codex 模式 |
| `happy connect` | 存储 AI 供应商 API 密钥 |
| `happy notify` | 发送推送通知 |
| `happy daemon` | 管理后台服务 |
| `happy doctor` | 系统诊断 |

### Token 监控
| 命令 | 描述 |
|---------|-------------|
| `happy --stats` | 查看 token 使用统计 |
| `happy --stats --format json` | JSON 格式输出 |
| `happy --stats --format compact` | 紧凑视图 |
| `happy --stats --watch` | 实时监控 |
| `happy --stats --model claude-3-5-sonnet` | 按模型筛选 |

### 模型管理
| 命令 | 描述 |
|---------|-------------|
| `happy --seeall` | 列出所有模型 |
| `happy --to <model>` | 切换模型 |
| `happy --to` | 显示当前模型 |
| `happy --toadd <name>` | 添加自定义模型 |
| `happy --del <name>` | 删除模型 |
| `happy --auto <pattern>` | 自动切换 (cheap/expensive/balanced) |
| `happy --exp <file>` | 导出配置 |
| `happy --imp <file>` | 导入配置 |

### 仪表板
| 命令 | 描述 |
|---------|-------------|
| `happy --dashboard` | 启动实时仪表板 |
| `happy --dashboard --refresh 500` | 自定义刷新率 |

---

## 高级用法

### 模型配置

创建自定义模型配置：

```bash
# 添加带自定义定价的模型
happy --toadd my-model \
  --model claude-3-5-sonnet \
  --cost "0.003:0.015" \
  --tags "reasoning,fast"
```

模型配置存储在 `~/.happy/model-config.json`:
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

### Token 使用追踪

在代码中监控 token 使用：

```typescript
import { createMonitoredQuery } from '@/claude/sdk'

const { query, tokenMonitor } = createMonitoredQuery({
    prompt: 'Your prompt here',
    options: { model: 'claude-3-5-sonnet' }
})

for await (const message of query) {
    // 处理消息
}

// 获取统计信息
const stats = tokenMonitor.getStats()
console.log(`总成本: $${stats.totalCost}`)
```

### 实时事件监听

```typescript
import { getTokenMonitor } from '@/claude/sdk'

const monitor = getTokenMonitor()

// 监听使用事件
monitor.on('usage', (usage) => {
    console.log(`新请求: ${usage.totalTokens} tokens`)
})

// 监听速率变化
monitor.on('stats', (stats) => {
    console.log(`当前速率: ${stats.currentRate.tokensPerSecond} t/s`)
})
```

---

## 配置

### 环境变量

| 变量 | 描述 | 默认值 |
|----------|-------------|---------|
| `HAPPY_SERVER_URL` | 自定义服务器 URL | https://api.cluster-fluster.com |
| `HAPPY_WEBAPP_URL` | 自定义 Web 应用 URL | https://app.happy.engineering |
| `HAPPY_HOME_DIR` | 数据目录 | ~/.happy |
| `HAPPY_DISABLE_CAFFEINATE` | 禁用 macOS 防睡眠 | false |
| `HAPPY_EXPERIMENTAL` | 启用实验功能 | false |

### 配置文件

- `~/.happy/model-config.json` - 模型配置和设置
- `~/.happy/token-usage.json` - Token 使用历史 (JSONL)
- `~/.happy/credentials` - 认证凭据
- `~/.happy/logs/` - 应用程序日志

---

## AI 提供商

Happy 支持多个 AI 提供商：

| 提供商 | 模型示例 | 说明 |
|----------|----------------|-------|
| **Anthropic** | claude-3-5-sonnet, claude-3-5-haiku | 主要提供商 |
| **MiniMax** | MM-1.0, MM-1.5 | 聊天/对话模型 |
| **GLM** | glm-4.6, glm-4-plus | 智谱 AI |
| **Kimi** | KIMI/kimi | 月之暗面 |

添加自定义提供商：
```bash
happy --toadd custom \
  --model your-model-id \
  --cost "input:output" \
  --provider custom
```

---

## 文档

📚 **更多文档：**
- [Token 监控指南](./TOKEN_MONITORING.md) - 完整 API 参考
- [快速开始指南](./GETTING_STARTED.md) - 快速入门教程
- [CLI 集成指南](./CLI_INTEGRATION.md) - 高级用法
- [实现总结](./IMPLEMENTATION_SUMMARY.md) - 技术细节
- [路线图](./roadmap.md) - 未来功能

---

## 故障排除

### 常见问题

**找不到模块错误**
```bash
# 解决方案：编译项目
npm run build
```

**守护进程未运行**
```bash
# 启动后台服务
happy daemon start
```

**权限被拒绝**
```bash
# 检查认证
happy auth status
```

运行诊断：
```bash
happy doctor
```

---

## 开发

### 项目结构
```
src/
├── index.ts                 # CLI 入口点
├── api/                     # API 客户端和认证
├── claude/                  # Claude Code 集成
│   ├── loop.ts             # 控制循环
│   └── sdk/                # SDK 集成
├── commands/               # 命令实现
│   ├── token-stats.ts     # Token 监控
│   ├── model-switch.ts    # 模型管理
│   └── dashboard.ts       # 实时仪表板
└── ui/                     # 用户界面
```

### 构建
```bash
npm run build    # 编译 TypeScript
npm run watch    # 监听模式
npm test         # 运行测试
```

---

## 许可证

MIT License - 详见 [LICENSE](LICENSE)

---

## 支持

- 📧 邮箱: support@happy.engineering
- 🐛 问题: [GitHub Issues](https://github.com/slopus/happy-cli/issues)
- 💬 Discord: [加入社区](https://discord.gg/happy)
- 📖 文档: [docs.happy.engineering](https://docs.happy.engineering)
