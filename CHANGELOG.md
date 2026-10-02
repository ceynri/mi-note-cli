# Changelog

本文件由 AI 从 git 历史归纳生成，发版时更新。

格式遵循 [Keep a Changelog](https://keepachangelog.com/)，版本号遵循 [Semantic Versioning](https://semver.org/)。

## [Unreleased] [[compare]](https://github.com/ceynri/mi-note-cli/compare/v0.3.1...HEAD)

### Added

- 引用本地图片文件（`![](./photo.jpg)`）在 `create` / `update` / `sync` 上行时自动上传，并登记为笔记附件，无需先运行 `upload-image`
- 交互式处理同步冲突时可按 `d` 查看云端与本地的差异
- 在本地子目录新建的笔记同步时建到同名云端文件夹，不存在则自动创建；云端标题取文件名
- `export` 增量缓存（放在全局缓存目录）：云端未变且本地未被改动的笔记不再逐条拉详情，`--force` 全量重来

### Changed

- 同步删除云端笔记改为移到回收站，不再永久删除
- `export` / `sync` 部分条目失败时在 `data.errors` 列出失败项，并以退出码 2 结束
- `--limit` 必须是正整数，非法值直接报错
- `create` / `update` 从 `--file` 读取内容时，相对图片路径基于该文件所在目录
- 找不到可用浏览器时提示安装 Chrome 或运行 `npx playwright install chromium`

### Fixed

- 本地修改带图笔记后同步上行，或 `get` → 修改 → `update` 时，图片被写成纯文本导致云端丢图；无法回写的附件引用现在会报错而不是静默丢失
- 同名笔记落盘到同一个文件，`export` 时互相覆盖，`sync` 时可能把一条笔记的内容上传覆盖另一条；同名时改为加 `_<id>` 后缀，并自动修复旧版本留下的错误状态
- 子目录（云端文件夹）里的笔记导出后图片引用是 `assets/...`，Markdown 查看器中无法显示；改为按目录深度写 `../assets/` 等相对前缀，旧文件在下次同步时自动修复
- 云端笔记 `setting.data` 里未登记附件的图片在导出时丢图；现在保留为 `minote://image/` 引用，仍可正常回写
- 附件下载失败时 `sync` 会删掉已写好的正文、反复重试；改为正文照常落盘并在 `data.errors` 中报告附件失败
- `export` 附件下载失败的笔记会被记入缓存、之后永远跳过；改为失败不进缓存，下次重试
- 在已有 `export` 产物的目录上首次 `sync --mode two-way` 会把所有笔记在云端重复创建一份
- `local-first` 模式或交互选择「以本地为准」时，「云端已删、本地已改」的笔记未能在云端重建
- 生成同步计划后云端或本地又被修改时，执行阶段会覆盖掉这次修改
- `--json` 模式下同步单条失败完全不可见

### Security

- cookie 缓存文件权限收紧为仅当前用户可读写

### Internal

- 新增 GitHub Actions CI（类型检查、单测、构建）
- 新增同步执行层单测（内存假客户端）

## [0.3.1] - 2026-06-22 [[compare]](https://github.com/ceynri/mi-note-cli/compare/v0.3.0...v0.3.1)

### Changed

- 明确 `export` 与 `sync --mode cloud-first` 的区别：状态文件、本地文件删除行为、`--force` 全量重下，在 README、CLI `--help`、SKILL.md 中补充对比说明
- SKILL.md 用户配置说明移至独立章节

## [0.3.0] - 2026-06-22 [[compare]](https://github.com/ceynri/mi-note-cli/compare/v0.2.0...v0.3.0)

### Breaking

- 同步模式重命名：`download` → `cloud-first`，`upload` → `local-first`，移除 `mirror`（原 `mirror` 行为合并进 `cloud-first`）
- 配置字段 `mode` 重命名为 `syncMode`（旧配置需手动更新）

### Changed

- 强化删除操作确认流程，防止误删
- SKILL.md 同步更新：模式名、配置字段名、新增版本漂移检测提示

## [0.2.0] - 2026-06-06 [[compare]](https://github.com/ceynri/mi-note-cli/compare/v0.1.2...v0.2.0)

### Changed

- 拆分用户配置与同步状态：用户配置（`syncMode` / `output` / `fileNameTemplate` 等）留在 `.mi-note-cli/config.json`，同步状态独立到 `<output>/.mi-note-cli.state.json`，配置可入版控而状态自动排除

## [0.1.2] - 2026-06-06 [[compare]](https://github.com/ceynri/mi-note-cli/compare/v0.1.1...v0.1.2)

### Added

- 同步落盘文件名模板（`fileNameTemplate` 配置项）与 Markdown↔XML 转换守恒守护

### Fixed

- 修复 esbuild postinstall 脚本权限问题

## [0.1.1] - 2026-06-06 [[compare]](https://github.com/ceynri/mi-note-cli/compare/v0.1.0...v0.1.1)

### Added

- 支持短效 serviceToken 静默续期，减少重复登录
- Markdown 转换器支持多行引用、下划线及栈式缩进推断
- 适配小米客户端有序列表的自闭合形态

### Changed

- 配置从全局 `~/.mi-note-cli.json` 改为项目本地 `.mi-note-cli/config.json`

### Fixed

- 修复 `--color` 选项校验缺失及非 JSON API 错误未正确抛出的问题

### Internal

- 添加 `.npmrc` 配置文件
- 添加 MIT License
- 添加发布构建脚本与仓库元信息
- 文档主语言切换为中文，新增英文版本

## [0.1.0] - 2026-05-31 [[release]](https://github.com/ceynri/mi-note-cli/releases/tag/v0.1.0)

初始发布，包含：

- 笔记 CRUD（创建、读取、更新、删除、移动、置顶）
- 文件夹管理
- 图片上传
- 导出（云→本地 Markdown）
- 双向同步（download / mirror / upload / two-way / manual 模式）
- `--json` 统一输出格式
- Cookie 自动续期
