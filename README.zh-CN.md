[English](./README.md) | 简体中文

# mi-note-cli

小米云笔记（i.mi.com）的全功能命令行工具——读取、创建、更新、删除、移动、置顶笔记，管理文件夹，上传图片，导出与**双向同步**。**专为 AI / 脚本调用设计**（统一 `--json` 输出、非交互模式快速失败）。

> 从旧的 mi-note-export 迁移？见 [MIGRATION.zh-CN.md](./MIGRATION.zh-CN.md)。

## 功能

- **认证**：浏览器交互式登录，Cookie 缓存
- **读**：列出笔记、查看单条笔记（转 Markdown）、关键词搜索、列出文件夹
- **写**：创建 / 更新 / 删除 / 移动 / 置顶笔记
- **文件夹**：创建 / 重命名 / 删除
- **图片**：上传本地图片，返回可嵌入笔记的引用
- **导出 `export`**：单向云→本地，把笔记导出为 Markdown（含附件、按文件夹组织），永不修改云端
- **同步 `sync`**：本地与云端双向同步，3-way 差异检测 + 多种冲突模式
- **AI 友好**：全局 `--json` 输出结构化结果；非交互环境下不弹浏览器、直接报错

## 安装

```bash
pnpm install
pnpm build
node dist/cli.js --help
# 或全局链接：npm link 后使用 mi-note-cli
```

> Playwright 仅用于登录时打开浏览器。优先使用系统已安装的 Chrome。

## 快速开始

```bash
mi-note-cli login                       # 1. 登录（打开浏览器）
mi-note-cli list --limit 20             # 2. 列出笔记
mi-note-cli get <笔记ID>                 # 3. 查看某条笔记
mi-note-cli create --title "标题" --content "# 正文"   # 4. 创建
mi-note-cli sync -o ./notes --mode two-way            # 5. 与本地双向同步
```

## 命令一览

| 命令 | 说明 |
|---|---|
| `login` / `logout` / `whoami` | 登录 / 清除登录态 / 查看状态 |
| `list [--folder <id>] [--limit <n>]` | 列出笔记 |
| `get <id> [--raw]` | 查看笔记（默认转 Markdown，`--raw` 出原始 XML） |
| `search <keyword> [--limit <n>]` | 搜索标题与摘要 |
| `create [--title] [--folder] [--content/--file]` | 创建笔记（也可从 stdin 读内容） |
| `update <id> [--title] [--folder] [--content/--file]` | 更新笔记 |
| `delete <id> [--purge] [-y]` | 删除（默认回收站，`--purge` 永久） |
| `move <id> <folderId>` | 移动笔记到文件夹 |
| `pin <id>` / `unpin <id>` | 置顶 / 取消置顶 |
| `folders` / `folder create\|rename\|delete` | 文件夹管理 |
| `upload-image <path>` | 上传图片，返回 `minote://image/{fileId}` 引用 |
| `export [-o <dir>] [-f]` | 单向导出为 Markdown |
| `sync [-o <dir>] [--mode M] [--dry-run] [-y]` | 双向同步 |
| `sync init` / `sync status` | 引导设置默认模式 / 查看配置 |

所有命令均支持全局 `--json`，输出 `{ ok, data }` / `{ ok: false, error }`。

## 导出 vs 同步

- **`export`**：单向云→本地快照，**永不修改云端**。适合"我只想备份"。本地改了不会回写。
- **`sync`**：本地与云端双向，基于「上次同步基线 / 云端现状 / 本地现状」三方对比，按模式处理差异与冲突。

### 同步模式（`--mode`）

| 模式 | 行为 |
|---|---|
| `download` | 云端优先：一切以云端为准，覆盖本地，不上行本地变更 |
| `mirror` | 本地镜像：云→本地下行，本地变更只检测不上行 |
| `upload` | 本地优先：一切以本地为准上行到云端 |
| `two-way` | 双向自动：单边改自动同步，真冲突才停下询问 |
| `manual`（默认） | 交互：任何不一致都列出并逐条询问 |

冲突（双改 / 一端删另一端改）处理：`download/mirror/upload` 已声明优先方，自动解决；`two-way/manual` 交互询问，非交互环境跳过并报告，**绝不擅自删数据**。

用 `sync init` 交互设置默认模式，之后 `sync` 可省略 `--mode`。`sync --dry-run` 只预览不执行。

## 在笔记中插入图片

```bash
mi-note-cli upload-image ./photo.png    # → ![图片](minote://image/xxxxxx)
mi-note-cli create --title "带图" --content "看图：

![图片](minote://image/xxxxxx)"
```

工具会自动把 `minote://image/{fileId}` 转换为小米笔记的图片标记。

## 数据目录

- **登录态缓存**（macOS）：`~/Library/Caches/mi-note-cli/`（`cookie` + `browser-data/`，可被系统/用户当缓存清理，清了重新 login 即可）
- **配置与同步状态**（持久，不被当缓存清理）：
  - macOS: `~/Library/Application Support/mi-note-cli/config.json`
  - Linux: `~/.config/mi-note-cli/config.json`
  - Windows: `%APPDATA%\mi-note-cli\config.json`
  - 单一文件，集中存放全局默认模式 + 各同步目录（以绝对路径为 key）的状态。

## 已知限制

- **回收站列表/恢复**：小米无公开接口，删除后只能在 [i.mi.com](https://i.mi.com) 网页端 30 天内恢复。
- **私密笔记 / 待办独立类型 / 思维导图**：无稳定写接口，导出尽力转换，不支持编辑。
- **用户标签**：小米笔记无用户标签体系（API 的 `tag` 是同步版本号）。
- **Cookie 时效**：登录态有效期有限，过期需重新 `login`。

## AI 调用建议

1. 始终加 `--json`，输出可直接解析。
2. 非交互环境（无 TTY）未登录会立即返回错误而非卡浏览器登录，请先人工 `login` 一次。
3. 删除等危险操作显式加 `-y`；sync 在非交互下真冲突会跳过不动数据。

## 开发

```bash
pnpm build              # 编译
pnpm test               # 单元测试（无需网络）
pnpm test:integration   # 真实 API 集成测试（需登录，写操作自清理）
```

## License

MIT
