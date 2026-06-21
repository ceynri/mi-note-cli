# TODO

## 去掉指令名后缀 `cli`

把 `mi-note-cli` 指令名字的后缀 `cli` 去掉。

受影响位置：
- `package.json` 里的 `name` 字段
- `README.md` / `README.en.md` 里的命令示例
- `src/cli.ts` 里的程序名（如果 hard code）
- 代码里任何以 `mi-note-cli` 作为命令名展示或生成的地方

注意：
- 去掉后缀后新的指令名应该叫 `mi-note`
- 需要确认 npm publish 时包名是否也要一起改
- 改名后需要同步更新依赖该命令名的脚本、CI、Skill、文档

为什么暂缓：属于破坏性变更，需要确认发布策略（major version bump + 迁移说明），不忙当前主线。

## Markdown 风格偏好配置

让 `xmlToMarkdown` 输出按用户偏好选择行内 markup 形式，并让 `markdownToXml` 同时识别多种形式。

可配置项 + 候选值：

| 项 | 候选 | 当前默认 |
|:---|:---|:---|
| bold | `**` / `__` | `**` |
| italic | `*` / `_` | `*` |
| strike | `~~` / `~` | `~~` |
| bullet | `-` / `*` / `+` | `-` |

实现步骤：

1. `AppConfig` 加 `markdownStyle?: { bold?, italic?, strike?, bullet? }`
2. `convertInlineStyles` 按配置输出
3. `inlineMdToXml` 扩识别所有候选形式（识别端越宽越好，避免漏识别导致语法字面化上传到云端）
4. 加 round-trip 单测覆盖每种组合
5. README 加配置说明

为什么暂缓：当前默认风格已经匹配主要使用者习惯，加配置后没立即收益；等真有用户反馈风格冲突再做。

## 双向同步漂移监测

3-way diff 在 Markdown 空间比对，转换不无损会被识别为「云端单边改动」并触发覆盖。可以加一个工具/选项专门检查转换守恒：

- `mi-note-cli sync diagnose` 子命令：抽样若干笔记做 `local md → markdownToXml → upload → fetch → xmlToMarkdown → md`，对比首尾是否相等，列出哪些笔记/语法在漂移
- 或者 sync 时检测到非预期的 baseHash 漂移自动告警（而不是默默走覆盖路径）

为什么暂缓：当前已支持语法实测无损（夹具单元 + 集成 round-trip 通过），漂移仅可能发生在不支持的语法上，README 已显式列出白名单与风险。等真出现漂移再做工具化排查。
