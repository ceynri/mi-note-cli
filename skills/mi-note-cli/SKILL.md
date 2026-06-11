---
name: mi-note-cli
description: 小米云笔记（i.mi.com）的全功能命令行工具，可读取、创建、更新、删除、移动、置顶笔记，管理文件夹，上传图片，导出与双向同步。当用户提到"小米笔记"、"小米云笔记"、"读写小米笔记"、"创建/更新/删除小米笔记"、"导出/同步小米笔记"、"mi-note-cli"时触发此 skill。
---

# mi-note-cli

操作小米云服务（i.mi.com）笔记的全功能 CLI。覆盖读、写、文件夹管理、图片上传、导出与双向同步。

## 核心原则

- **始终加 `--json`**：所有命令支持 `--json`，输出 `{ "ok": true, "data": ... }` 或 `{ "ok": false, "error": "..." }`，便于解析。
- **非交互安全**：未登录时在非交互环境会立即返回错误，不会卡在浏览器登录。若报"未登录"，需先由用户在终端执行 `mi-note-cli login`。
- **危险操作显式确认**：`delete` 默认会要求确认；脚本调用时加 `-y`。永久删除需显式 `--purge`（否则只是移到回收站）。

## 使用

通过 `npx` 直接执行，无需提前全局安装：

### 读

```bash
npx mi-note-cli list --json [--folder <id>] [--limit <n>]   # 列出笔记
npx mi-note-cli get <id> --json                              # 查看笔记（转 Markdown）
npx mi-note-cli get <id> --raw                               # 查看原始 XML
npx mi-note-cli search <关键词> --json [--limit <n>]          # 搜索
npx mi-note-cli folders --json                               # 列出文件夹
```

### 写

```bash
# 创建：内容可来自 --content、--file 或 stdin
npx mi-note-cli create --title "标题" --content "# 正文" --json
echo "正文" | npx mi-note-cli create --title "标题" --json
npx mi-note-cli create --file ./note.md --folder <folderId> --json

# 更新：仅传需要改的字段；不传 content 则只改元数据
npx mi-note-cli update <id> --content "新正文" --json
npx mi-note-cli update <id> --title "新标题" --json

# 删除 / 移动 / 置顶
npx mi-note-cli delete <id> -y --json            # 移到回收站
npx mi-note-cli delete <id> --purge -y --json    # 永久删除
npx mi-note-cli move <id> <folderId> --json
npx mi-note-cli pin <id> --json
npx mi-note-cli unpin <id> --json
```

### 文件夹

```bash
npx mi-note-cli folder create "名称" --json [--parent <id>]
npx mi-note-cli folder rename <id> "新名称" --json
npx mi-note-cli folder delete <id> -y --json [--purge]
```

### 图片

```bash
# 1. 上传图片，得到 fileId 与可嵌入的 Markdown
npx mi-note-cli upload-image ./photo.png --json
# 返回 data.markdown: ![图片](minote://image/xxxxxx)

# 2. 把该 Markdown 放进 create/update 的 --content 中即可
```

### 导出（单向云→本地）

```bash
npx mi-note-cli export -o <dir> --json   # 导出为 Markdown（含附件），永不修改云端
npx mi-note-cli export -f -o <dir>       # 强制重新导出
```

export 只读云端、写本地，适合"只想备份"。本地内容相同则跳过；不回写云端。

### 同步（双向）

```bash
npx mi-note-cli sync -o <dir> --mode <mode> --json   # 双向同步
npx mi-note-cli sync -o <dir> --dry-run              # 只预览计划不执行
npx mi-note-cli sync init                            # 交互设默认模式
npx mi-note-cli sync status --json                   # 查看配置与各目录状态
```

模式 `--mode`：
- `download` 云端优先（覆盖本地，不上行）
- `mirror` 本地镜像（只下行，本地变更不上行）
- `upload` 本地优先（上行覆盖云端）
- `two-way` 双向自动（真冲突才停）
- `manual`（默认）任何不一致都逐条询问

基于「上次同步基线 / 云端现状 / 本地现状」三方对比。冲突时：有优先方的模式自动解决；`two-way/manual` 在非交互环境**跳过并报告，绝不擅自删数据**（需交互或 `-y`）。

遇到其他场景，优先 `npx mi-note-cli <command> --help` 查阅选项（--help 含输出约定、模式说明、示例）。

## 内容格式

笔记内容以 Markdown 形式读写，工具自动在 Markdown 与小米自有 XML 间双向转换。支持：标题（#/##/###）、有序/无序列表、复选框（`- [ ]` / `- [x]`）、引用（`>`）、分割线（`---`）、加粗/斜体/删除线、图片（`minote://image/{fileId}`）。

## Agent 执行删除的约束

执行 `delete` / `folder delete` / 会删除数据的 `sync` 前，**必须**遵循以下流程：

1. **身份确认**：通过 `get <id> --json` 获取云端笔记内容，与本地文件做比对，确认是目标待删除笔记。尤其当本地文件名与状态文件记录不一致时，**禁止跳过此步骤**。
2. **展示确认**：除非用户明确表示不需要，否则应向用户展示待删除对象的关键信息（ID、标题、内容摘要），获得明确确认后再执行。
3. **执行删除**：确认无误后加 `-y` 执行。永久删除（`--purge`）需二次确认。

**绝对禁止**：仅凭 subject 相似或时间接近就推断是同一篇笔记并直接删除。

## 运行时数据

- 登录态缓存：`~/Library/Caches/mi-note-cli/`（`cookie` + `browser-data/`）
- 用户配置：项目根 `.mi-note-cli/config.json`，存 `mode` / `output` / `fileNameTemplate` 等用户偏好；可入版控、团队共享
- 默认 output：用户配置和 CLI `-o` 都缺省时落到 `.mi-note-cli/output/`
- 同步状态：`<output>/.mi-note-cli.state.json`，存同步基线（笔记内容哈希、`filePath`、上次同步云端 modify）；自动生成、跟 output 1:1 绑定、不入版控

## 限制（客观条件，无法实现）

- 回收站列表 / 恢复：无公开接口，删除后只能在 i.mi.com 网页端 30 天内恢复
- 私密笔记 / 待办独立类型 / 思维导图：无稳定写接口，导出尽力转换，不支持编辑
- 用户标签：小米笔记无用户标签体系
- Cookie：短效 serviceToken 过期会自动用持久化的长效登录态静默续期，通常无需重新 login；仅长效登录态也失效时才需重新 `login`
