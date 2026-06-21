[English](./README.en.md) | 简体中文

# mi-note-cli

小米云笔记（i.mi.com）的全功能命令行工具——读取、创建、更新、删除、移动、置顶笔记，管理文件夹，上传图片，导出与**双向同步**。**专为 AI / 脚本调用设计**（统一 `--json` 输出、非交互模式快速失败）。

> 从旧的 mi-note-export 迁移？见 [MIGRATION.md](./MIGRATION.md)。

> ⚠️ **实验阶段**：本项目仍在快速迭代中，minor 版本（`x.Y.z`）的更新就可能包含破坏性变更。如果你追求稳定性，请将依赖锁定到 minor 版本（如 `~0.1.0` 而非 `^0.1.0`）。升级后出现问题时，可查看最新 [Releases](https://github.com/ceynri/mi-note-cli/releases) 的更新说明，确认是已知变更后提 [issue](https://github.com/ceynri/mi-note-cli/issues)。

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

### 作为 CLI 工具

```bash
npm install -g mi-note-cli
```

> 环境要求：Node.js >= 18。Playwright 仅用于登录时打开浏览器，优先使用系统已安装的 Chrome。

### 作为 AI Skill

通过 [`npx skills`](https://github.com/agentc-app/skills) 安装内置 skill，让 AI Agent 了解此工具的用法：

```bash
npx -y skills add ceynri/mi-note-cli --all
```

或自选安装到哪些 agent：

```bash
npx skills add ceynri/mi-note-cli
```

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
| `cloud-first` | 云端优先：仅下行，冲突以云端为准 |
| `local-first` | 本地优先：仅上行，冲突以本地为准 |
| `two-way` | 双向自动：单边改自动同步，真冲突才停下询问 |
| `manual`（默认） | 交互：任何不一致都列出并逐条询问 |

冲突（双改 / 一端删另一端改）处理：`cloud-first`/`local-first` 已声明优先方，自动解决；`two-way`/`manual` 交互询问，非交互环境跳过并报告，**绝不擅自删数据**。

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
- **用户配置**：项目根 `.mi-note-cli/config.json`，存同步模式 / 默认同步目录 / 文件名模板等用户偏好。CLI 在哪个目录执行就在该目录的 `.mi-note-cli/` 下读写。可随项目提交，团队共享同一份偏好。
- **默认 output**：用户配置和 CLI `-o` 都缺省时，落到 `.mi-note-cli/output/`，零配置即可使用。
- **同步状态**：`<output>/.mi-note-cli.state.json`，存同步基线（各笔记的内容哈希、`filePath`、上次同步云端 modify 等）。跟着 output 目录走，整个 output 可整体迁移仍可继续 sync；不入版控，把 output 加进 `.gitignore` 就一并忽略。

### 自定义同步行为（可选）

在 `.mi-note-cli/config.json` 中可加以下字段：

```json
{
  "syncMode": "cloud-first",
  "output": "./mi-notes",
  "fileNameTemplate": "${YYYY}-${MM}-${DD}_${HH}-${mm}-${ss}[_${title}]"
}
```

- `syncMode`：默认同步模式，`sync` 不传 `--mode` 时使用
- `output`：默认同步/导出目录，`sync` / `export` 不传 `-o` 时使用（相对路径基于项目根）
- `fileNameTemplate`：控制 `sync` / `export` 落盘时的文件名格式（不含 `.md` 后缀）

以上面的模板为例，导出的文件名会长成：

- 有标题的笔记 → `2026-06-06_14-03-00_读书笔记.md`
- 没起标题的笔记 → `2026-06-06_14-03-00.md`

**占位符**

| 占位符 | 含义 |
|---|---|
| `${YYYY}` / `${YY}` | 4 位 / 2 位年 |
| `${MM}` `${DD}` | 月 / 日（零填充） |
| `${HH}` `${mm}` `${ss}` | 时 / 分 / 秒（24 小时制，零填充） |
| `${title}` | 笔记真实标题。用户没起标题时为**空字符串** |
| `${subject}` | 永远非空的笔记称呼：有标题用标题，无标题用内容首行或创建时间 |
| `${id}` | 笔记 ID |

时间分量基于笔记**创建时间**的本地时区。

**条件段 `[...]`**

方括号内的内容只有当其中所有 `${var}` 都非空时才出现，否则**整段连同分隔符一起消失**。最常见的用法是把可选的标题段包起来：

```
${YYYY}-${MM}-${DD}[_${title}]
```

- 有标题 → `2026-06-06_读书笔记`
- 无标题 → `2026-06-06`

需要字面 `[` `]` 时用 `\[` `\]` 转义。

**默认行为**

未配置 `fileNameTemplate` 时等价于 `${subject}`，永有非空文件名。模板**不支持 `/`**：文件夹结构始终由小米云端 folder 决定，模板只产文件名。

## 已知限制

### 服务端能力

- **回收站列表/恢复**：小米无公开接口，删除后只能在 [i.mi.com](https://i.mi.com) 网页端 30 天内恢复。
- **私密笔记 / 待办独立类型 / 思维导图**：无稳定写接口，导出尽力转换，不支持编辑。
- **用户标签**：小米笔记无用户标签体系（API 的 `tag` 是同步版本号）。
- **Cookie 时效**：短效 `serviceToken` 过期时会自动用本地持久化的长效登录态静默续期，通常无需重新 `login`；仅当长效登录态也失效时才需重新 `login`。

### Markdown 语法支持范围（实验性）

> 项目刚起步，实际使用样本还不多，转换器可能存在已知或未知的漏洞。重要笔记建议先在小范围验证，重要内容做手动备份；遇到不对的转换欢迎反馈。

**已稳定支持**（单元/集成 round-trip 双向往返测试覆盖）：标题（H1–H3）、有序/无序列表（含多级嵌套、跨段续号）、复选框、引用、分割线、加粗 `**bold**` / 斜体 `*italic*` / 删除线 `~~strike~~` / 下划线 `<u>...</u>`、链接、行内代码、段落、图片附件。

**当前不支持**：表格、脚注、定义列表、围栏代码块语言标识、Setext 风格标题（`===` / `---`）、`<u>` 之外的内嵌 HTML。这些语法在转换时会被悄悄丢弃或保留为字面文本。

**双向同步注意**：本工具的 3-way diff 在 Markdown 空间比对，若转换不无损会被识别为「云端单边改了」并触发覆盖。如果你重度依赖不在上面白名单的语法、或观察到本地 markdown 风格在同步后被改写，建议优先用 `manual` / `two-way` 模式（遇到分歧会停下询问），不要默认 `cloud-first`。

---

## 贡献与反馈

项目处于早期阶段，遇到转换异常、缺失功能、想加新占位符等任何想法——欢迎 [提 issue](https://github.com/ceynri/mi-note-cli/issues) 或 PR。Repro 越小越好。

---

## AI 调用建议

1. 始终加 `--json`，输出可直接解析。
2. 非交互环境（无 TTY）未登录会立即返回错误而非卡浏览器登录，请先人工 `login` 一次。
3. 删除等危险操作显式加 `-y`；sync 在非交互下真冲突会跳过不动数据。

---

## 开发

```bash
git clone https://github.com/ceynri/mi-note-cli.git
cd mi-note-cli
pnpm install
pnpm build              # 编译
pnpm dev                # 监听模式编译
pnpm test               # 单元测试（无需网络）
pnpm test:integration   # 真实 API 集成测试（需登录，写操作自清理）
```

## License

MIT
