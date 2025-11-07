# Internationalization (i18n) Guide

> **Help us translate Happy into your language!**

We welcome contributions to translate Happy's documentation and user interface into multiple languages. This guide explains how to contribute to internationalization.

---

## Table of Contents

1. [Directory Structure](#directory-structure)
2. [Translation Guidelines](#translation-guidelines)
3. [Adding a New Language](#adding-a-new-language)
4. [Updating Existing Translations](#updating-existing-translations)
5. [Testing Translations](#testing-translations)
6. [Style Guide](#style-guide)

---

## Directory Structure

Translations are organized in the `docs/i18n/` directory:

```
docs/i18n/
├── README.md                    # This file - i18n guide
├── README_en.md                 # English version
├── README_zh.md                 # Chinese version
├── README_ja.md                 # Japanese version (in progress)
├── README_ko.md                 # Korean version (in progress)
├── en/                          # English documentation
│   ├── README.md
│   ├── TOKEN_MONITORING.md
│   ├── GETTING_STARTED.md
│   └── CLI_INTEGRATION.md
├── zh/                          # Chinese documentation
│   ├── README.md
│   ├── TOKEN_MONITORING.md
│   ├── GETTING_STARTED.md
│   └── CLI_INTEGRATION.md
├── ja/                          # Japanese documentation
│   ├── README.md
│   └── ...
└── ko/                          # Korean documentation
    ├── README.md
    └── ...
```

### File Naming Conventions

- Main README: `README_<lang>.md` (e.g., `README_zh.md`)
- Other docs: Store in `docs/i18n/<lang>/<doc-name>.md`

---

## Translation Guidelines

### 1. Accuracy

- **Be accurate** - Translate concepts, not just words
- **Use technical terms correctly** - Maintain consistency with industry standards
- **Verify translations** - Double-check critical information

### 2. Clarity

- **Write clearly** - Use simple, direct language
- **Avoid ambiguity** - Be specific and precise
- **Consider your audience** - Balance technical accuracy with accessibility

### 3. Consistency

- **Use consistent terminology** - Same concept = same translation
- **Follow style guide** - See [Style Guide](#style-guide) below
- **Match source structure** - Keep same headings and organization

### 4. Cultural Adaptation

- **Adapt examples** - Use culturally relevant examples when appropriate
- **Keep code examples** - Never translate code, variable names, or command syntax
- **Preserve URLs** - Keep original URLs, add translations in parentheses if needed

---

## Adding a New Language

### Step 1: Choose Language Code

Use ISO 639-1 language codes:
- `en` - English
- `zh` - Chinese (Simplified)
- `zh-TW` - Chinese (Traditional)
- `ja` - Japanese
- `ko` - Korean
- `es` - Spanish
- `fr` - French
- `de` - German
- `ru` - Russian
- `pt` - Portuguese
- `it` - Italian

### Step 2: Create Directory Structure

```bash
# Create language directory
mkdir -p docs/i18n/<lang-code>

# Copy English version as template
cp docs/i18n/en/README.md docs/i18n/<lang-code>/
```

### Step 3: Translate Files

1. Start with `README.md` - This is the most important file
2. Then translate: `GETTING_STARTED.md`, `TOKEN_MONITORING.md`, `CLI_INTEGRATION.md`
3. Create `README_<lang>.md` in the root for language switcher

### Step 4: Update Language Switcher

Update the main `README.md` to include your language:

```markdown
[English](./docs/i18n/README_en.md) | [中文](./docs/i18n/README_zh.md) | [Your Language](./docs/i18n/README_your-lang.md)
```

### Step 5: Submit Pull Request

1. Commit your changes
2. Create a pull request with title: `[i18n] Add <language> translation`
3. Include a checklist in the PR description

---

## Updating Existing Translations

When the English version is updated, translations should be updated too.

### Detection

We track English version updates through:
- Git history comparison
- [PR labels](https://github.com/slopus/happy-cli/labels) - look for `i18n-update` label
- [GitHub Discussions](https://github.com/slopus/happy-cli/discussions) - i18n announcements

### Update Process

1. **Identify changed files** - Check the PR or commit for modified files
2. **Update translations** - Apply changes to all language versions
3. **Verify consistency** - Ensure all versions stay in sync
4. **Submit PR** - Create pull request with updated translations

### Change Tracking

Mark outdated translations with a comment:

```markdown
<!-- Last synced: YYYY-MM-DD -->
```

This helps track which files need updating.

---

## Testing Translations

### 1. Content Review

- [ ] All sections are translated
- [ ] Code examples are intact
- [ ] Links work correctly
- [ ] Formatting is preserved
- [ ] Terminology is consistent

### 2. Language Review

- [ ] Grammar and syntax are correct
- [ ] Natural language flow
- [ ] Technical terms are accurate
- [ ] Cultural adaptation is appropriate

### 3. Technical Review

- [ ] Markdown renders correctly
- [ ] No broken links
- [ ] Images are accessible
- [ ] No untranslated strings in code blocks

---

## Style Guide

### General Rules

#### Pronouns
- **English**: Use "you" (second person)
- **Chinese**: Use "你" (second person)
- **Japanese**: Use "あなた" or omit when context is clear
- **Korean**: Use "당신" or "당신은"

#### Tone
- **Professional but friendly**
- **Clear and concise**
- **Helpful and supportive**
- **Avoid slang** unless widely understood

#### Technical Terms

Keep these in English, with translation in parentheses on first use:

- CLI → CLI (命令行界面)
- SDK → SDK (软件开发工具包)
- API → API (应用程序接口)
- Token → Token (令牌)
- Dashboard → Dashboard (仪表板)
- WebSocket → WebSocket (网络套接字)
- JSON → JSON (JavaScript 对象表示法)

### Language-Specific Guidelines

#### Chinese (中文)

- Use Simplified Chinese (简体中文) for Mainland China
- Use Traditional Chinese (繁體中文) for Taiwan, Hong Kong, Macau
- Avoid Western punctuation in Chinese text, use Chinese punctuation:
  - Use "、" instead of commas in lists
  - Use "。" for periods
  - Use "：" for colons
- Format numbers: 10,000 (with commas)

#### Japanese (日本語)

- Use polite form (です/ます形) for documentation
- Use katakana for foreign words: コマンド, ダッシュボード
- Use appropriate honorifics: 先生, 方
- Format numbers: 10,000 (with commas)

#### Korean (한국어)

- Use formal form (습니다/합니다) for documentation
- Use Hangul for Korean words
- Use English for technical terms
- Format numbers: 10,000 (with commas)

---

## Code Examples

### Never Translate

```bash
# ❌ WRONG - Don't translate commands
happy --stats    # ❌ Don't translate to "happy --统计"
```

```bash
# ✅ CORRECT - Keep commands in English
happy --stats    # ✅ Keep original command
```

### Translate Comments

```bash
# ✅ CORRECT - Translate comments
happy --stats    # 查看 token 使用统计
```

### Translate String Literals (User-Facing)

```typescript
// ✅ CORRECT - Translate user-facing messages
console.log("Total cost: $" + cost)  // Show in local language

// For Chinese:
console.log("总成本: $" + cost)
```

---

## Resources

### Translation Tools
- [Lokalise](https://lokalise.com/) - Professional translation management
- [Crowdin](https://crowdin.com/) - Collaborative translation platform
- [GitLocalize](https://gitlocalize.com/) - Git-based translation
- [OmegaT](https://omegat.org/) - Free translation memory software

### Language Resources
- **Chinese**: [简体中文语法指南](https://www.chinesegrammar.info/)
- **Japanese**: [日本語スタイルガイド](https://www.jtf.jp/en/style/style_guide_eng.html)
- **Korean**: [한국어 문법 가이드](https://ko.wikipedia.org/wiki/한국어의_문법)

### Terminology Databases
- [Microsoft Terminology Collection](https://www.microsoft.com/en-us/language/Search?&defaultTerm=Command%20Line%20Interface&searchType=&langID=7&src=false&confirm SR=Submit&CTYP=&NHLANG=&NRC=&WCATS=&LID=&ISV=&LPATH=&AC=&SRCH=&SP=N&PF=&DC=&DN=&CF=&NE=&GW=&SV=&CT=&CFID=&CFTID=&AVL=&SRC=)
- [Apple Style Guide](https://help.apple.com/applestyleguide/)

---

## Best Practices

### Do's ✅

- ✅ Keep source and translation in sync
- ✅ Use consistent terminology
- ✅ Test all links and code examples
- ✅ Ask for reviews from native speakers
- ✅ Document translation decisions
- ✅ Use translation memory tools
- ✅ Respect cultural differences

### Don'ts ❌

- ❌ Don't use machine translation without review
- ❌ Don't translate technical terms incorrectly
- ❌ Don't change the document structure
- ❌ Don't leave untranslated placeholders
- ❌ Don't use inconsistent capitalization
- ❌ Don't translate code or config files
- ❌ Don't ignore style guide conventions

---

## Quality Assurance

### Review Process

1. **Self-review** - Check your own translation
2. **Peer review** - Have another translator review
3. **Native speaker review** - Get feedback from native speakers
4. **Technical review** - Verify all links and code
5. **Final review** - Maintainer approval

### Checklist

Before submitting a translation:

- [ ] All text is translated
- [ ] Code examples work correctly
- [ ] Links are functional
- [ ] Formatting is preserved
- [ ] Terminology is consistent
- [ ] Grammar and syntax are correct
- [ ] Cultural adaptation is appropriate
- [ ] Review by native speaker completed

---

## Recognition

Contributors who complete significant translation work will be:

1. **Listed in CONTRIBUTORS.md** with their language
2. **Mentioned in release notes** for major translations
3. **Given contributor badge** on GitHub
4. **Invited to translation team** for ongoing maintenance

### Contributors

Special thanks to our translation contributors:

- **English**: Original authors
- **Chinese**: Community contributions
- **Japanese**: In progress
- **Korean**: In progress

Want to see your name here? [Start translating!](#adding-a-new-language)

---

## Support

Need help with translations?

- 📧 Email: i18n@happy.engineering
- 💬 Discord: [#translations](https://discord.gg/happy)
- 🐛 Issues: [Label: i18n](https://github.com/slopus/happy-cli/issues?q=is%3Aissue+is%3Aopen+label%3Ai18n)
- 📖 Wiki: [Translation Wiki](https://github.com/slopus/happy-cli/wiki/Translations)

---

## License

All translations are released under the same MIT License as the original project.

By contributing translations, you agree to license your contributions under the MIT License.
