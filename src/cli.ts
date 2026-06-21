#!/usr/bin/env node

import { createRequire } from "node:module";
import { Command } from "commander";
import { setJsonMode } from "./output.js";

import {
  loginCommand,
  logoutCommand,
  whoamiCommand,
} from "./commands/auth-commands.js";
import { listCommand } from "./commands/list.js";
import { getCommand } from "./commands/get.js";
import { searchCommand } from "./commands/search.js";
import { createCommand } from "./commands/create.js";
import { updateCommand } from "./commands/update.js";
import { deleteCommand } from "./commands/delete.js";
import { moveCommand } from "./commands/move.js";
import { pinCommand } from "./commands/pin.js";
import {
  foldersCommand,
  folderCreateCommand,
  folderRenameCommand,
  folderDeleteCommand,
} from "./commands/folder.js";
import { uploadImageCommand } from "./commands/upload-image.js";
import { exportCommand } from "./commands/export.js";
import {
  syncCommand,
  syncInitCommand,
  syncStatusCommand,
} from "./commands/sync.js";

const require = createRequire(import.meta.url);
const { version, description } = require("../package.json") as {
  version: string;
  description: string;
};

const program = new Command();

program
  .name("mi-note-cli")
  .description(description)
  .version(version, "-v, --version", "显示版本号")
  .option("--json", "以 JSON 格式输出（便于 AI / 脚本解析）")
  .hook("preAction", (thisCommand) => {
    if (thisCommand.opts().json) {
      setJsonMode(true);
    }
  });

program.addHelpText(
  "after",
  `
输出约定:
  全局 --json 下，所有命令统一输出 JSON：成功 {"ok":true,"data":...}，失败 {"ok":false,"error":"..."}。
  失败时进程以非零码退出。日志/进度走 stderr，结构化结果走 stdout，可安全用管道解析。

笔记内容格式:
  读取(get)默认把小米笔记转成 Markdown；写入(create/update)接受 Markdown，自动转回小米格式。
  支持的 Markdown: 标题(# ## ###)、有序/无序列表、复选框(- [ ] / - [x])、引用(>)、
  分割线(---)、加粗(**)、斜体(*)、删除线(~~)、图片(![](minote://image/<fileId>))。

典型流程:
  1) mi-note-cli login                          # 首次登录（浏览器）
  2) mi-note-cli list --json                     # 列出笔记，拿到 <id>
  3) mi-note-cli get <id> --json                 # 读取某条笔记
  4) mi-note-cli create --title T --content "..." # 创建
  5) mi-note-cli sync -o ./notes --mode two-way  # 与本地目录双向同步

非交互/AI 调用:
  无 TTY 或带 --json 时不会弹浏览器；未登录会直接返回错误，需先人工 login。
  破坏性操作(delete / sync 删除类)在非交互下需 -y 或由 --mode 决定，真冲突一律跳过不擅自删数据。
`,
);

// ============ 认证 ============
program
  .command("login")
  .description("登录小米账号（打开浏览器完成登录）")
  .action(() => loginCommand());

program
  .command("logout")
  .description("清除本工具的登录态与缓存")
  .action(() => logoutCommand());

program
  .command("whoami")
  .description("查看当前登录状态")
  .action(() => whoamiCommand());

// ============ 读 ============
program
  .command("list")
  .description("列出笔记")
  .option("-f, --folder <id>", "仅列出指定文件夹下的笔记（id 来自 folders 命令）")
  .option("-n, --limit <n>", "限制返回数量")
  .action((opts) => listCommand(opts));

program
  .command("get <id>")
  .description("获取单条笔记内容（默认转 Markdown）")
  .option("--raw", "输出原始 XML 内容")
  .action((id, opts) => getCommand(id, opts))
  .addHelpText("after", "\n  <id> 来自 list / search 命令的输出。--json 时 data 含 id/title/content/files 等字段。\n");

program
  .command("search <keyword>")
  .description("按关键词搜索笔记标题与摘要")
  .option("-n, --limit <n>", "限制返回数量（默认 20）")
  .action((keyword, opts) => searchCommand(keyword, opts));

// ============ 写 ============
program
  .command("create")
  .description("创建笔记（内容来源：--content / --file / 标准输入）")
  .option("-t, --title <title>", "笔记标题")
  .option("-f, --folder <id>", "目标文件夹 ID（默认 0）")
  .option("-c, --content <md>", "笔记内容（Markdown）")
  .option("--file <path>", "从文件读取内容")
  .option("--color <id>", "笔记颜色 ID")
  .action((opts) => createCommand(opts))
  .addHelpText(
    "after",
    `
示例:
  mi-note-cli create --title "标题" --content "# 正文\\n\\n- 列表项"
  echo "# 来自管道" | mi-note-cli create --title 管道笔记
  mi-note-cli create --file ./note.md --folder 123 --json
  先用 upload-image 拿到 ![](minote://image/<fileId>)，放进 --content 即可插图。
`,
  );

program
  .command("update <id>")
  .description("更新笔记（不提供内容则仅改元数据）")
  .option("-t, --title <title>", "新标题")
  .option("-f, --folder <id>", "移动到的文件夹 ID")
  .option("-c, --content <md>", "新内容（Markdown）")
  .option("--file <path>", "从文件读取新内容")
  .option("--color <id>", "笔记颜色 ID")
  .action((id, opts) => updateCommand(id, opts));

program
  .command("delete <id>")
  .description("删除笔记（默认移回收站，--purge 永久删除）")
  .option("--purge", "永久删除（不可恢复）")
  .option("-y, --yes", "跳过确认")
  .action((id, opts) => deleteCommand(id, opts));

program
  .command("move <id> <folderId>")
  .description("将笔记移动到指定文件夹")
  .action((id, folderId) => moveCommand(id, folderId));

program
  .command("pin <id>")
  .description("置顶笔记")
  .action((id) => pinCommand(id, true));

program
  .command("unpin <id>")
  .description("取消置顶笔记")
  .action((id) => pinCommand(id, false));

// ============ 文件夹 ============
program
  .command("folders")
  .description("列出所有文件夹")
  .action(() => foldersCommand());

const folder = program
  .command("folder")
  .description("文件夹管理（create / rename / delete）");

folder
  .command("create <name>")
  .description("创建文件夹")
  .option("-p, --parent <id>", "父文件夹 ID（默认 0）")
  .action((name, opts) => folderCreateCommand(name, opts));

folder
  .command("rename <id> <name>")
  .description("重命名文件夹")
  .action((id, name) => folderRenameCommand(id, name));

folder
  .command("delete <id>")
  .description("删除文件夹")
  .option("--purge", "永久删除")
  .option("-y, --yes", "跳过确认")
  .action((id, opts) => folderDeleteCommand(id, opts));

// ============ 图片 ============
program
  .command("upload-image <path>")
  .description("上传图片，返回可嵌入笔记的 fileId 与 Markdown 引用")
  .option("--mime <type>", "图片 MIME 类型（默认自动推断）")
  .option("--filename <name>", "上传时使用的文件名")
  .action((path, opts) => uploadImageCommand(path, opts));

// ============ 导出/同步 ============
program
  .command("export")
  .description("导出全部笔记为本地 Markdown（单向云→本地，永不修改云端）")
  .option("-o, --output <dir>", "输出目录（缺省时取用户配置的 output；再缺省为 .mi-note-cli/output/）")
  .option("-f, --force", "强制重新导出（忽略本地已有同名文件）")
  .action((opts) => exportCommand(opts));

const sync = program
  .command("sync")
  .description("双向同步本地与云端（3-way 差异 + 模式策略）")
  .option("-o, --output <dir>", "同步目录（缺省时取用户配置的 output；再缺省为 .mi-note-cli/output/）")
  .option("-m, --mode <mode>", "同步模式：cloud-first/local-first/two-way/manual")
  .option("--dry-run", "只列出同步计划，不实际执行")
  .option("-y, --yes", "跳过交互询问（非交互按模式处理，真冲突跳过）")
  .action((opts) => syncCommand(opts))
  .addHelpText(
    "after",
    `
同步模式 (--mode，未指定时取 sync init 设的默认值，再缺省为 manual):
  cloud-first  云端优先：仅下行，冲突以云端为准
  local-first   本地优先：仅上行，冲突以本地为准
  two-way       双向自动：单边改自动同步，真冲突才停下询问
  manual        交互（默认）：任何不一致都列出并逐条询问

冲突处理:
  cloud-first/local-first 已声明优先方，冲突按优先方自动解决；
  two-way/manual 遇到「双改」「一端删另一端改」等真冲突会停下：交互式询问，
  非交互(--json/无 TTY)则跳过该条并在结果里报告，绝不擅自删数据。

示例:
  mi-note-cli sync -o ./notes --dry-run        # 预览将发生什么
  mi-note-cli sync -o ./notes --mode two-way    # 双向同步
  mi-note-cli sync init                          # 引导设置默认模式
  mi-note-cli sync status                        # 查看配置与状态
`,
  );

sync
  .command("init")
  .description("交互式引导设置默认同步模式")
  .option("-o, --output <dir>", "为指定目录设置模式")
  .action((opts) => syncInitCommand(opts));

sync
  .command("status")
  .description("查看用户配置与当前 output 的同步状态")
  .option("-o, --output <dir>", "查看指定目录的状态（缺省时取用户配置的 output；再缺省为 .mi-note-cli/output/）")
  .action((opts) => syncStatusCommand(opts));

program.parseAsync(process.argv);
