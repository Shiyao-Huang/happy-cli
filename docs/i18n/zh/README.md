# Happy CLI

Claude
Code 的移动端和 Web 客户端，具有模型管理、令牌监控和实时会话控制等强大功能。

免费。开源。随时随地编程。

## 安装

```bash
npm install -g happy-coder
```

## 快速开始

```bash
happy
```

这将：

1. 启动启用了移动控制的 Claude Code 会话
2. 显示二维码，可从移动设备连接
3. 允许在 Claude Code 和移动应用之间实时共享会话
4. 启用模型切换和令牌监控等高级功能

## 命令兼容性

Happy CLI 支持**两套命令系统**，提供最大灵活性：

1. **超简单命令**（推荐）- 常用模型的快速单字命令
2. **完整功能命令** - 完整的标志集合，用于高级使用

两套系统可同时工作 - 使用适合您工作流程的任意一套！

## 主要命令

### 超简单命令（推荐）

- `ccglm` - 启动 GLM 模型会话（yolo 模式）
- `ccmm` - 启动 MiniMax 模型会话（yolo 模式）
- `cckimi` - 启动 Kimi 模型会话（yolo 模式）
- `ccglm --no` - 启动 GLM 模型会话（普通模式）
- `ccmm --no` - 启动 MiniMax 模型会话（普通模式）
- `cckimi --no` - 启动 Kimi 模型会话（普通模式）

### 会话控制

- `happy` - 启动新的 Claude 会话并启用移动控制
- `happy --resume` - 恢复之前的会话
- `happy --yolo` - 启动会话并跳过权限检查（用于自动化）
- `happy --to <model>` - 切换到特定模型（例如 claude-3-5-haiku）
- `happy --yolo --to <model>` - 切换模型并启动会话（例如 GLM）
- `happy --to <model> --yolo` - 支持反向参数顺序（yolo 模式）

### 模型管理

- `happy --seeall` - 列出所有可用模型
- `happy --toadd <name>` - 添加新的模型配置
- `happy --del <name>` - 删除模型配置
- `happy --upd <name>` - 更新模型配置
- `happy --auto <pattern>` - 自动切换模型（expensive|cheap|balanced）
- `happy --exp <file>` - 导出模型配置
- `happy --imp <file>` - 导入模型配置

### 令牌监控

- `happy --stats` - 查看每日令牌使用情况
- `happy --watch` - 实时令牌监控
- `happy --f compact` - 紧凑输出格式
- `happy --f table` - 表格输出格式
- `happy --f json` - JSON 输出格式
- `happy daily` - 按天统计
- `happy weekly` - 按周统计
- `happy monthly` - 按月统计
- `happy --since 20240101` - 从指定日期过滤
- `happy --until 20241231` - 过滤到指定日期

### 仪表板

- `happy --dashboard` - 打开实时监控仪表板

### 实用命令

- `happy auth` – 管理认证和机器设置
- `happy auth login` – 向服务进行认证
- `happy auth logout` – 移除认证凭据
- `happy connect` – 将 AI 供应商 API 密钥连接到 Happy 云
- `happy notify -p "message"` – 向您的设备发送推送通知
- `happy codex` – 启动 Codex 模式（MCP 桥接）
- `happy daemon` – 管理后台服务
- `happy doctor` – 系统诊断和故障排除
- `happy doctor clean` – 清理失控的进程

### 守护进程管理

- `happy daemon start` – 启动后台守护进程
- `happy daemon stop` – 停止守护进程（会话保持活跃）
- `happy daemon status` – 显示守护进程状态
- `happy daemon list` – 列出活跃会话
- `happy daemon stop-session <id>` – 停止特定会话
- `happy daemon logs` – 显示守护进程日志文件路径
- `happy daemon install` – 安装守护进程服务
- `happy daemon uninstall` – 卸载守护进程服务

## 选项

### 通用选项

- `-h, --help` - 显示帮助
- `-v, --version` - 显示版本
- `--started-by <mode>` - 启动方式（daemon|terminal）
- `--happy-starting-mode <mode>` - 启动模式（local|remote）

### 模型和权限选项

- `-m, --model <model>` - 要使用的 Claude 模型（默认：sonnet）
- `-p, --permission-mode <mode>` - 权限模式：auto、default 或 plan
- `--yolo` - 跳过所有权限（危险）
- `--dangerously-skip-permissions` - 跳过权限检查（等同于 --yolo）

### Claude 集成

- `--claude-env KEY=VALUE` - 为 Claude Code 设置环境变量
- `--claude-arg ARG` - 向 Claude CLI 传递额外参数
- `--resume` - 恢复之前的会话
- **Happy 支持所有 Claude 选项！** - 您可以像使用 claude 一样将任何 claude 标志与 happy 一起使用

## 环境变量

### 服务器配置

- `HAPPY_SERVER_URL` - 自定义服务器 URL（默认：https://api.happy-servers.com）
- `HAPPY_WEBAPP_URL` - 自定义 Web 应用 URL（默认：https://app.happy.engineering）
- `HAPPY_HOME_DIR` - Happy 数据的自定义主目录（默认：~/.happy）

### 系统

- `HAPPY_DISABLE_CAFFEINATE` - 禁用 macOS 睡眠预防（设置为 `true`、`1` 或
  `yes`）
- `HAPPY_EXPERIMENTAL` - 启用实验性功能（设置为 `true`、`1` 或 `yes`）

### Claude 集成

- `ANTHROPIC_DEFAULT_SONNET_MODEL` - 覆盖默认 Sonnet 模型
- `ANTHROPIC_MODEL` - 设置默认 Claude 模型
- `ANTHROPIC_BASE_URL` - 自定义 Anthropic API 基础 URL
- `ANTHROPIC_AUTH_TOKEN` - Anthropic API 认证令牌

## 示例

### 超简单命令

```bash
ccglm                          # 启动 GLM 会话（yolo 模式）
ccmm                           # 启动 MiniMax 会话（yolo 模式）
cckimi                         # 启动 Kimi 会话（yolo 模式）
ccglm --no                     # 启动 GLM 会话（普通模式）
ccmm --no                      # 启动 MiniMax 会话（普通模式）
cckimi --no                    # 启动 Kimi 会话（普通模式）
```

### 启动会话

```bash
happy                          # 启动新会话
happy --resume                 # 恢复之前的会话
happy --yolo                   # 跳过权限启动
happy --yolo --to GLM          # 切换到 GLM 并启动（yolo 模式）
happy --to GLM --yolo          # 同上（反向顺序）
```

### 模型管理

```bash
happy --to claude-3-5-haiku    # 切换到 Haiku 模型
happy --yolo --to GLM          # 切换到 GLM 并启动
happy --seeall                 # 列出所有可用模型
happy --toadd my-model         # 添加自定义模型
```

### 令牌监控

```bash
happy --stats                  # 查看每日令牌使用情况
happy --watch                  # 实时监控
happy --stats -f compact       # 紧凑格式
happy --stats weekly           # 按周分组
happy --stats --since 20240101 --until 20241231  # 日期范围
```

### 高级功能

```bash
happy --dashboard              # 打开实时仪表板
happy auth login --force       # 重新认证
happy notify -p "Test"         # 发送通知
happy daemon status            # 检查守护进程
happy doctor                   # 运行诊断
```

## 系统要求

- **Node.js >= 20.0.0**
  - `eventsource-parser@3.0.5` 需要此版本
  - `@modelcontextprotocol/sdk` 需要上述包，用于权限转发
- **已安装并登录 Claude CLI**（PATH 中可访问 `claude` 命令）

## 架构

Happy CLI 是三组件系统的一部分：

1. **Happy CLI**（本项目）- 包装 Claude Code 的命令行界面
2. **Happy** - React Native 移动客户端
3. **Happy Server** - 基于 Prisma 的 Node.js 服务器（托管在
   https://api.happy-servers.com/）

### 核心功能

- **双模式操作**：交互式（终端）和远程（移动控制）
- **端到端加密**：所有通信使用 TweetNaCl 加密
- **会话持久化**：跨重启恢复会话
- **模型管理**：使用配置在不同的 Claude 模型间切换
- **令牌监控**：实时跟踪和历史统计
- **守护进程架构**：后台服务管理会话
- **权限转发**：移动应用批准/拒绝 Claude 权限

## 许可证

MIT
