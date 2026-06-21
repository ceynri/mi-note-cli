# Changelog

本文件由 AI 从 git 历史归纳生成，发版时更新。

格式遵循 [Keep a Changelog](https://keepachangelog.com/)，版本号遵循 [Semantic Versioning](https://semver.org/)。

## [Unreleased] [[compare]](https://github.com/ceynri/mi-note-cli/compare/v0.3.1...HEAD)

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
