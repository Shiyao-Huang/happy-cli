# Happy CLI Development Guide

## 代码规范化 (Code Quality)

本项目使用以下工具确保代码质量：

### 1. Prettier - 代码格式化

- **行长度限制**: 100 字符
- **配置文件**: `.prettierrc`
- **自动格式化**: 通过 pre-commit 钩子

### 2. ESLint - 代码检查

- **配置文件**: `eslint.config.mjs`
- **TypeScript 支持**: 使用 `typescript-eslint`
- **规则**: 严格模式，启用类型检查

### 3. Pre-commit 钩子

自动在每次提交前运行以下检查：

- 代码格式化 (Prettier)
- 代码检查 (ESLint)
- TypeScript 类型检查
- 尾随空白检查
- 大文件检查
- 密钥泄露检测

## 安装和设置

### 1. 安装 pre-commit

```bash
# 使用 pip 安装 (推荐)
pip3 install pre-commit

# 或使用 brew (macOS)
brew install pre-commit

# 或使用 npm
npm install -g pre-commit
```

### 2. 安装 git hooks

```bash
# 在项目根目录执行
pre-commit install

# 安装 commit-msg hook
pre-commit install --hook-type commit-msg
```

### 3. 运行所有检查

```bash
# 格式化所有文件
yarn format

# 检查代码
yarn lint

# 自动修复代码问题
yarn lint:fix

# 类型检查
yarn lint:types

# 运行所有检查
yarn pre-commit
```

## 手动运行 pre-commit

```bash
# 在所有文件上运行
pre-commit run --all-files

# 在特定文件上运行
pre-commit run prettier -- files/you/modified.ts

# 跳过 hooks (不推荐)
git commit --no-verify
```

## IDE 集成

### VS Code

安装以下扩展：

- Prettier - Code formatter
- ESLint
- TypeScript Hero

### 配置建议

在 VS Code 设置中启用：

```json
{
  "editor.formatOnSave": true,
  "editor.codeActionsOnSave": {
    "source.fixAll.eslint": true
  },
  "typescript.preferences.importModuleSpecifier": "relative"
}
```

## 提交规范

本项目使用 [Conventional Commits](https://www.conventionalcommits.org/) 规范：

### 格式

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

### 类型 (type)

- `feat`: 新功能
- `fix`: 修复bug
- `docs`: 文档更新
- `style`: 代码格式化 (不影响代码含义)
- `refactor`: 重构
- `test`: 测试相关
- `chore`: 构建流程或辅助工具变动

### 示例

```bash
feat(api): 添加用户认证功能
fix(claude): 修复会话恢复问题
docs: 更新 API 文档
style: 格式化代码
refactor(utils): 重构工具函数
```

## 配置文件说明

### .prettierrc

```json
{
  "printWidth": 100, // 行长度限制
  "tabWidth": 2, // 缩进大小
  "semi": true, // 语句结尾分号
  "singleQuote": true, // 使用单引号
  "trailingComma": "es5", // 尾随逗号
  "bracketSpacing": true, // 对象括号内空格
  "arrowParens": "always" // 箭头函数参数括号
}
```

### eslint.config.mjs

- 基于 TypeScript 推荐规则
- 禁用与 Prettier 冲突的规则
- 严格模式：禁止未使用变量、魔法数字等

### .pre-commit-config.yaml

定义了在提交前自动运行的所有 hooks

## 故障排除

### Pre-commit 失败

```bash
# 更新 hooks
pre-commit autoupdate

# 清理并重新安装
pre-commit clean
pre-commit install
```

### ESLint 错误

```bash
# 查看详细错误
yarn lint

# 自动修复
yarn lint:fix
```

### Prettier 格式化冲突

```bash
# 强制格式化
yarn format

# 检查哪些文件需要格式化
yarn format:check
```

## 持续集成

CI 管道中自动运行：

1. `yarn lint:types` - TypeScript 类型检查
2. `yarn lint` - ESLint 检查
3. `yarn test` - 单元测试

任何检查失败都会导致构建失败。
