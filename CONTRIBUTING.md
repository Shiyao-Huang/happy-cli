# 🤝 参与 Aha 开发

感谢你对 Aha 项目感兴趣！我们欢迎所有形式的贡献，无论是代码、文档、设计还是反馈。

## 🌟 为什么参与 Aha？

- 🚀 **影响成千上万的开发者** - Aha 正在改变开发者的工作方式
- 🧠 **学习前沿技术** - AI、多智能体系统、实时通信、端到端加密
- 🤝 **与顶尖开发者协作** - 我们的社区充满热情和才华
- 📈 **个人品牌建设** - 你的贡献会被署名和认可
- 🎁 **专属福利** - 早期功能访问、社区认可、周边礼品

## 🎯 贡献方式

### 1. 💻 代码贡献

#### 适合初学者的 Issue
寻找标记为 `good first issue` 的问题：
```
https://github.com/Shiyao-Huang/happy-cli/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22
```

#### 开发流程

1. **Fork 项目**
```bash
# Fork 到你的 GitHub 账号
# 然后 clone 到本地
git clone https://github.com/YOUR_USERNAME/aha-cli.git
cd aha-cli
```

2. **创建功能分支**
```bash
git checkout -b feature/amazing-feature
```

3. **安装依赖**
```bash
yarn install
```

4. **开发和测试**
```bash
# 开发模式
yarn dev

# 运行测试
yarn test

# 类型检查
yarn typecheck
```

5. **提交更改**
```bash
git add .
git commit -m "feat: Add amazing feature"
```

我们使用 [Conventional Commits](https://www.conventionalcommits.org/) 规范：
- `feat:` 新功能
- `fix:` Bug 修复
- `docs:` 文档更新
- `style:` 代码格式（不影响功能）
- `refactor:` 代码重构
- `test:` 测试相关
- `chore:` 构建/工具相关

6. **推送并创建 PR**
```bash
git push origin feature/amazing-feature
```

然后在 GitHub 上创建 Pull Request。

#### 代码规范

- ✅ 使用 TypeScript，严格类型检查
- ✅ 函数和类需要 JSDoc 注释
- ✅ 遵循现有代码风格
- ✅ 测试覆盖率 > 80%
- ✅ 不引入不必要的依赖
- ✅ 性能优先（特别是移动端）

### 2. 📝 文档贡献

文档和代码一样重要！

#### 文档类型
- **使用指南** - 帮助用户快速上手
- **API 文档** - 详细的接口说明
- **架构文档** - 系统设计和实现原理
- **最佳实践** - 使用技巧和案例
- **翻译** - 多语言支持

#### 文档工作流
```bash
# 1. 编辑 Markdown 文件
vim docs/getting-started.md

# 2. 提交 PR
git add docs/
git commit -m "docs: Improve getting started guide"
git push
```

### 3. 🎨 设计贡献

我们需要：
- UI/UX 设计
- 图标和插图
- 品牌视觉
- 营销素材

设计资源请提交到 `design/` 目录。

### 4. 🐛 报告 Bug

发现 Bug？帮我们修复它！

#### Bug 报告模板
```markdown
**描述**
简要描述问题

**复现步骤**
1. 执行 '...'
2. 点击 '....'
3. 看到错误

**期望行为**
应该发生什么

**实际行为**
实际发生了什么

**环境**
- OS: macOS 14.0
- Node.js: v20.0.0
- Aha 版本: 1.18.1

**截图/日志**
如果可能，请附上截图或日志
```

### 5. 💡 功能建议

有好想法？我们想听！

#### 功能建议模板
```markdown
**功能描述**
简要描述你想要的功能

**使用场景**
为什么需要这个功能？它解决了什么问题？

**替代方案**
你考虑过其他解决方案吗？

**实现思路**
如果你有技术想法，请分享
```

### 6. 🧪 测试贡献

帮我们提高代码质量：
- 编写单元测试
- 编写集成测试
- 性能测试
- 端到端测试

### 7. 🌍 国际化

帮助 Aha 走向世界：
- 翻译用户界面
- 翻译文档
- 本地化支持

## 🎓 技术栈

了解这些技术将帮助你更好地贡献：

### 核心技术
- **TypeScript** - 类型安全的 JavaScript
- **Node.js** - 服务端运行时
- **Socket.IO** - 实时通信
- **TweetNaCl** - 加密库

### 移动端
- **React Native** - 跨平台移动开发
- **Expo** - React Native 工具链

### 后端
- **Fastify** - 高性能 HTTP 框架
- **Prisma** - 数据库 ORM

### AI 集成
- **Claude Code SDK** - Anthropic 官方 SDK
- **MCP** - Model Context Protocol

## 🏗️ 项目结构

```
aha-cli/
├── src/
│   ├── api/          # API 客户端和加密
│   ├── claude/       # Claude 集成
│   │   ├── team/     # 多智能体系统
│   │   └── mcp/      # MCP 服务器
│   ├── daemon/       # 守护进程
│   ├── ui/           # CLI 界面
│   └── index.ts      # 入口文件
├── shared/
│   └── team-config/  # 团队配置和角色
│       └── skills/   # 22 个内置角色
├── docs/             # 文档
├── tests/            # 测试
└── scripts/          # 工具脚本
```

## 🎯 开发优先级

### P0 - 核心功能
- [ ] 移动端稳定性
- [ ] 端到端加密
- [ ] 团队协作
- [ ] 实时同步

### P1 - 增强功能
- [ ] 自定义角色
- [ ] 团队模板
- [ ] 性能优化
- [ ] 错误处理

### P2 - 未来规划
- [ ] VS Code 插件
- [ ] 桌面客户端
- [ ] 云端 IDE 集成
- [ ] 分析仪表板

## 🏆 贡献者激励

### 认可系统
- 🥇 **核心贡献者** - 10+ 个 PR 合并
- 🥈 **活跃贡献者** - 5+ 个 PR 合并
- 🥉 **新秀贡献者** - 首个 PR 合并

### 奖励
- ⭐ **专属徽章** - 在 README 中展示
- 🎁 **周边礼品** - T恤、贴纸等
- 🎟️ **早期访问** - 新功能抢先体验
- 💬 **社区特权** - Discord VIP 频道
- 📚 **技术分享** - 在我们的博客发文

### 月度之星
每月我们会评选：
- **最佳代码贡献**
- **最佳文档贡献**
- **最佳设计贡献**
- **最佳社区建设**

获奖者将获得：
- 🏆 专属证书
- 💰 $100 礼品卡
- 📣 社交媒体宣传

## 👥 核心团队

想加入核心团队？我们寻找：
- 💻 全栈开发者
- 🤖 AI 工程师
- 📱 移动开发者
- 🎨 UI/UX 设计师
- 📝 技术作家
- 🌍 社区经理

核心团队成员享有：
- 🔑 代码库写权限
- 💼 决策参与权
- 🎤 演讲机会
- 💰 收益分成（如有）

感兴趣？发邮件到 hsy863551305@gmail.com

## 📞 联系我们

### 日常交流
- **Discord**: https://discord.gg/aha (开发讨论、实时聊天)
- **GitHub Discussions**: 长期讨论、功能规划
- **Twitter**: @aha_engineering (最新动态)

### 私密沟通
- **Email**: hsy863551305@gmail.com
- **微信**: CopizzaH（请备注"Aha开发"）

### 定期会议
- **周会** - 每周五晚上 8:00 (GMT+8)
- **月度回顾** - 每月最后一个周六
- **季度规划** - 每季度第一周

加入 Discord 获取会议链接。

## 🎉 贡献者名单

感谢所有贡献者！你们让 Aha 变得更好。

### 核心贡献者 (10+ PRs)
- [@swmtjy](https://github.com/swmtjy) - 创始人 & 核心开发

### 所有贡献者
查看完整列表：[Contributors](https://github.com/Shiyao-Huang/happy-cli/graphs/contributors)

## 📜 行为准则

我们致力于提供友好、安全、包容的环境。

### 我们的承诺
- ✅ 尊重不同观点和经验
- ✅ 接受建设性批评
- ✅ 关注对社区最有利的事
- ✅ 对其他成员表示同理心

### 不可接受的行为
- ❌ 骚扰、歧视、侮辱性言论
- ❌ 人身攻击或政治攻击
- ❌ 公开或私下骚扰
- ❌ 未经许可发布他人隐私信息

违反准则者将被警告或移除。

## 🚀 开始贡献

准备好了吗？

1. ⭐ **Star** 这个项目
2. 🍴 **Fork** 到你的账号
3. 💻 选择一个 [Issue](https://github.com/Shiyao-Huang/happy-cli/issues) 开始
4. 💬 在 [Discord](https://discord.gg/aha) 介绍自己

**我们期待你的贡献！** 🎉

---

<div align="center">

**Together, we make coding accessible anywhere! 🚀**

[Start Contributing](https://github.com/Shiyao-Huang/happy-cli/issues) •
[Join Discord](https://discord.gg/aha) •
[Read Docs](https://docs.aha.engineering)

</div>
