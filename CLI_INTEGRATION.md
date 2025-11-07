# CLI Integration - Token Monitoring Commands

## 问题：为什么使用 `--` 命令？

您问得对！我之前的实现中，在文档里示例化了 `--` 命令，但实际上**没有真正实现CLI参数解析**。那只是**示例**而已。

## 真实实现

我已经将token监控命令**真正集成**到happy CLI中，使用与现有命令相同的手写参数解析系统。

## 可用命令

### 1. `happy token-stats`

**真正可用的命令** - 不需要 `node dist/...`，直接用 `happy` 前缀：

```bash
# 基本用法
happy token-stats

# 实时监控模式
happy token-stats --watch

# 紧凑格式
happy token-stats --format compact

# JSON输出
happy token-stats --format json

# 查看特定模型
happy token-stats --model claude-3-5-sonnet

# 自定义刷新间隔
happy token-stats --watch --interval 1000

# 获取帮助
happy token-stats --help
```

### 2. `happy model-switch`

```bash
# 列出所有模型
happy model-switch --list

# 切换模型
happy model-switch --set claude-3-5-haiku

# 添加新模型
happy model-switch --add my-model --cost "0.003:0.015" --tags "fast,cheap"

# 移除模型
happy model-switch --remove my-model

# 自动切换
happy model-switch --auto cheap
happy model-switch --auto expensive
happy model-switch --auto balanced

# 导出配置
happy model-switch --export model-config.json

# 导入配置
happy model-switch --import model-config.json

# 获取帮助
happy model-switch --help
```

### 3. `happy dashboard`

```bash
# 启动实时仪表板
happy dashboard

# 自定义刷新率
happy dashboard --refresh 500

# 获取帮助
happy dashboard --help
```

## 集成方式

这些命令已经**完全集成**到 `index.ts` 中，与 `auth`、`connect`、`daemon` 等命令平级：

```typescript
// 在 index.ts 中的集成
} else if (subcommand === 'token-stats') {
  try {
    await handleTokenStatsCli(args.slice(1));
  } catch (error) {
    console.error(chalk.red('Error:'), error.message)
    process.exit(1)
  }
  return;
} else if (subcommand === 'model-switch') {
  try {
    await handleModelSwitchCli(args.slice(1));
  } catch (error) {
    console.error(chalk.red('Error:'), error.message)
    process.exit(1)
  }
  return;
} else if (subcommand === 'dashboard') {
  try {
    await handleDashboardCli(args.slice(1));
  } catch (error) {
    console.error(chalk.red('Error:'), error.message)
    process.exit(1)
  }
  return;
}
```

## CLI文件结构

```
src/
├── index.ts                              # 主CLI入口 - 集成所有命令
├── commands/
│   ├── token-stats.ts                    # 核心实现
│   ├── token-stats-cli.ts                # CLI解析器
│   ├── model-switch.ts                   # 核心实现
│   ├── model-switch-cli.ts               # CLI解析器
│   ├── dashboard.ts                      # 核心实现
│   └── dashboard-cli.ts                  # CLI解析器
└── claude/sdk/
    ├── tokenMonitor.ts                   # 实时监控引擎
    ├── modelManager.ts                   # 模型管理引擎
    └── query.ts                          # 带监控的查询
```

## `--` 的作用

`--` 是**Unix/Linux标准约定**：

- **单连字符** `-` 短选项：`-h`, `-v`, `-w`
- **双连字符** `--` 长选项：`--watch`, `--format`, `--model`
- **双连字符后是参数值**：`--format json`, `--interval 1000`

在命令中：
```bash
happy token-stats --watch --interval 2000
        └─────────┘   └────┘  └────────┘   └────┘
        主命令        选项     选项名      选项值
```

## 帮助系统

每个命令都有完整的帮助：

```bash
happy --help                    # 主帮助
happy token-stats --help        # token-stats帮助
happy model-switch --help       # model-switch帮助
happy dashboard --help          # dashboard帮助
```

帮助内容包括：
- 用法说明
- 所有可用选项
- 示例
- 错误处理

## 为什么使用这种设计？

1. **一致性** - 与happy现有命令（auth、connect、daemon）保持一致
2. **无依赖** - 不使用外部CLI框架，用现有的手写解析器
3. **可维护** - 每个命令独立的文件，易于维护
4. **可扩展** - 轻松添加新命令或选项
5. **用户友好** - 标准Unix命令行约定

## 实际使用示例

### 示例 1：监控当前会话
```bash
# 在一个终端启动仪表板
happy dashboard

# 在另一个终端运行查询
# (使用createMonitoredQuery的代码会自动记录到仪表板)
```

### 示例 2：查看token统计
```bash
# 查看详细统计
happy token-stats

# 实时监控（每2秒更新）
happy token-stats --watch

# 紧凑视图
happy token-stats --format compact
```

### 示例 3：管理模型
```bash
# 查看可用模型
happy model-switch --list

# 切换到更便宜的模型
happy model-switch --set claude-3-5-haiku

# 根据成本自动切换
happy model-switch --auto cheap
```

## 验证安装

编译并测试：
```bash
# 编译
npm run build

# 查看主帮助（应包含新命令）
happy --help

# 测试token-stats
happy token-stats --help

# 测试model-switch
happy model-switch --help

# 测试dashboard
happy dashboard --help
```

## 总结

✅ **真正集成**到happy CLI中
✅ **标准**Unix命令行约定（--选项）
✅ **完整**的帮助系统
✅ **一致**的命令风格
✅ **无外部依赖**

现在这些命令是happy CLI的**第一公民**，可以像 `auth`、`connect`、`daemon` 一样使用！
