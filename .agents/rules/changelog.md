---
name: changelog
description: 发版时从 git 历史生成 CHANGELOG.md。当用户提到"发版"、"release"、"changelog"、"更新日志"时触发。
alwaysApply: false
---

# Changelog 生成规则

发版时 AI 负责从 git 历史归纳生成 changelog，用户审核后落盘。

## 触发时机

用户说"发版"、"更新 changelog"、"写 changelog"、"准备 release"等时触发。

## 生成流程

1. **确定版本范围**：
   - 获取最新 tag：`git tag --sort=-v:refname | head -1`
   - 读取 `package.json` 中的 `version` 字段
   - 范围：`<最新 tag>..HEAD`

2. **读取 commit 历史**：
   ```bash
   git log <prev_tag>..HEAD --format="%s"
   ```
   如需更多上下文，可加 `--format="%H %s"` 再读具体 diff。

3. **归纳为用户面向的条目**：
   - 按 [Keep a Changelog](https://keepachangelog.com/) 分类：Added / Changed / Deprecated / Removed / Fixed / Security
   - **语义归纳**：多个内部 refactor 合并为一条面向用户的描述；多个相关小 fix 合并；chore/internal 类改动归入 Internal 或省略
   - **去噪音**：版本号 commit（如 "0.2.0"）、纯文档格式调整不入 changelog
   - **用自然语言**：写用户关心的变化，不照搬 commit message

4. **写入 CHANGELOG.md**：
   - 新版本段落插在 `[Unreleased]` 下方
   - 原 `[Unreleased]` 内容并入新版本
   - 每个版本标题行附带 `[[compare]](https://github.com/<user>/<repo>/compare/<prev>...<tag>)` 内联链接，首个版本用 `[[release]](...)` 链接

5. **展示给用户审核**：输出新版本段落内容，等用户确认或修改

## 格式约定

```markdown
## [Unreleased] [[compare]](https://github.com/<user>/<repo>/compare/<latest>...HEAD)

## [x.y.z] - YYYY-MM-DD [[compare]](https://github.com/<user>/<repo>/compare/<prev>...<tag>)

### Added
- 新功能描述

### Changed
- 变更描述

### Fixed
- 修复描述

### Internal
- 内部改动（可选，用户可能关心的架构变化）
```

## 注意事项

- 日期用 tag 创建日期：`git log -1 --format=%ai <tag>`
- `package.json` 的 version 应与即将发布的版本号一致
- 如果 `[Unreleased]` 下有内容，合并到新版本段落中
