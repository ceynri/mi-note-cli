# 从 mi-note-export 迁移到 mi-note-cli

`mi-note-cli` 是一个功能完整、独立的小米云笔记命令行工具。如果你之前用的是只能导出的 `mi-note-export`，本文帮你迁移。

> mi-note-cli 是独立工具，**不依赖、不读取、不修改** mi-note-export 的任何内容。仅本文档提及旧工具。

## 主要差异

| | mi-note-export | mi-note-cli |
|---|---|---|
| 范围 | 仅导出（云→本地） | 完整读写 + 文件夹 + 图片上传 + 导出 + **双向同步** |
| 命令 | 单命令 | `login`/`list`/`get`/`search`/`create`/`update`/`delete`/`move`/`pin`/`folders`/`upload-image`/`export`/`sync` |
| AI 友好 | — | 全局 `--json`，非交互环境快速失败 |
| 本地↔云端 | 单向快照 | `export`（单向）+ `sync`（双向，含冲突模式） |

## 命令对照

| mi-note-export | mi-note-cli |
|---|---|
| `mi-note`（增量导出） | `mi-note-cli export -o <目录>` |
| `mi-note --force` | `mi-note-cli export -o <目录> --force` |
| `mi-note --delete-id <id>` | `mi-note-cli delete <id>` |
| `mi-note --login` | `mi-note-cli login` |
| `mi-note --clear-cache` | `mi-note-cli logout` |

旧工具没有的新能力：`sync`（双向）、`create`、`update`、`move`、`pin`、文件夹管理、`upload-image`、`search`。

## 登录

登录态**不会**沿用。运行一次 `mi-note-cli login` 完成认证（打开浏览器）。mi-note-cli 维护自己独立的 cookie 缓存，与旧工具完全隔离。

## 配置与状态

- 旧：工作目录的 `.mi-note-export.json` + 输出目录内的 `.sync-state.json`。
- 新：拆成两份，思路与旧 mi-note-export 一致——
  - **用户配置**：项目根 `.mi-note-cli/config.json`，存 `mode` / `output` / `fileNameTemplate` 等用户偏好（可入版控、团队共享）
  - **同步状态**：`<output>/.mi-note-cli.state.json`，存同步基线（自动生成、跟 output 1:1 绑定、不入版控）
- 默认 output 落到 `.mi-note-cli/output/`，用户既不传 `-o` 也未配 `output` 时使用。

不会自动导入旧配置。复刻旧设置：

```bash
# 旧: { "output": "./my-notes" }
# 新: 直接传 -o，或用 init 设默认同步模式
mi-note-cli export -o ./mi-notes      # 单向，行为同旧工具
mi-note-cli sync init                  # 可选：设默认同步模式
```

## 推荐路径

1. `mi-note-cli login`
2. 只想备份（旧行为）：`mi-note-cli export -o ./mi-notes`
3. 想让本地修改回流云端：`mi-note-cli sync -o ./mi-notes --mode two-way`

你的 `mi-note-export` 安装与数据原样保留，可独立保留或删除。
