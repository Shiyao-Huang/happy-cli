# Happy (Happy CLI)

> **移动编码** - 随时随地用手机控制 Claude Code

**Happy** 是一个强大的 CLI 工具，它包装 Claude Code 以实现远程控制和会话共享。直接从手机控制 Claude，实时监控 token 使用情况，并无缝管理多个 AI 模型。

[![MIT 许可证](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20+-green.svg)](https://nodejs.org/)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-2.0+-orange.svg)](https://docs.anthropic.com/en/docs/claude-code/overview)

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

# 一键切换模型并运行
happy --yolo --to GLM

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
| `happy --yolo --to <model>` | 切换模型并运行（一个命令） |
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

## 安全配置

### 🔒 API 密钥管理

**Happy CLI 优先考虑安全性 - 绝不硬编码 API 密钥！**

#### 配置文件

在以下位置之一创建配置文件：
- `~/.happy/APIs`（推荐）
- `/Users/swmt/Documents/auto_claude_proxy/APIs`（项目特定）
- `./APIs`（当前目录）

#### 设置示例

1. **复制模板：**
```bash
cp examples/API_CONFIG.template ~/.happy/APIs
```

2. **编辑您的 API 密钥：**
```bash
# 将占位符替换为真实值
YOUR_MINIMAX_API_KEY_HERE    → eyJhbGciOiJSUzI1Ni...
YOUR_ZHIPU_API_KEY_HERE      → xxxxx.yyyyy.zzzzz
YOUR_MOONSHOT_API_KEY_HERE   → sk-xxxxxxxxxx
```

3. **设置安全权限：**
```bash
chmod 600 ~/.happy/APIs
```

4. **测试配置：**
```bash
happy --seeall  # 应该显示所有 12 个模型
happy --to MM   # 测试 MiniMax
happy --to GLM  # 测试 GLM
happy --to KIMI # 测试 Kimi
```

#### 可用模型（共 12 个）

| 提供商 | 模型 | 别名 |
|----------|--------|---------|
| **内置** | claude-3-5-sonnet, claude-3-5-haiku, claude-3-opus, gpt-4o, gpt-4o-mini | - |
| **MiniMax** | MiniMax-M2 | MiniMax, MM |
| **GLM** | glm-4.6 | GLM, glm |
| **Kimi** | kimi-k2-thinking | Kimi, KIMI, kimi |

#### 安全最佳实践

✅ **应该做的：**
- 仅在配置文件中存储 API 密钥
- 使用 `chmod 600` 限制文件权限
- 将配置文件排除在版本控制之外
- 定期轮换 API 密钥
- 为开发/生产使用不同的密钥

❌ **不应该做的：**
- 绝不在源代码中硬编码 API 密钥
- 绝不要将 API 密钥提交到 git
- 绝不在聊天或论坛中分享 API 密钥
- 绝不在测试中使用生产密钥

#### 文档

📚 **安全资源：**
- [API 配置指南](./API_CONFIGURATION.md) - 完整设置说明
- [安全指南](./SECURITY.md) - 最佳实践和事件响应
- [配置示例](./examples/api-config-example.md) - 分步指南
- [安全摘要](./SECURITY_DOCUMENTATION_SUMMARY.md) - 概览

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
