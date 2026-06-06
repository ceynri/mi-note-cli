import { getClient } from "./shared.js";
import {
  buildSyncPlan,
  executeSyncPlan,
  type SyncPlanItem,
} from "../sync.js";
import {
  resolveMode,
  resolveOutputDir,
  setMode,
  loadUserConfig,
  loadState,
  getUserConfigPath,
  getStatePath,
  ALL_MODES,
} from "../config.js";
import { isJsonMode, success, logInfo, fail } from "../output.js";
import { createInterface } from "node:readline";
import type { SyncMode } from "../types.js";
import type { SyncAction } from "../sync-diff.js";

interface SyncOptions {
  output?: string;
  mode?: string;
  dryRun?: boolean;
  yes?: boolean;
}

const MODE_DESC: Record<SyncMode, string> = {
  download: "云端优先：一切以云端为准，覆盖本地，不上行本地变更",
  mirror: "本地镜像：云→本地下行，本地变更只检测不上行（≈纯导出）",
  upload: "本地优先：一切以本地为准上行到云端",
  "two-way": "双向自动：单边改自动同步，真冲突才停下询问",
  manual: "交互（默认）：任何不一致都列出并逐条询问",
};

/** 场景的人类可读说明 */
const SCENARIO_DESC: Record<string, string> = {
  "both-changed": "云端与本地都修改了",
  "remote-deleted-local-changed": "云端已删除，但本地有修改",
  "local-deleted-remote-changed": "本地已删除，但云端有修改",
  "local-changed": "本地有修改",
  "local-new": "本地新增",
  "remote-deleted-local-clean": "云端已删除",
  "local-deleted-remote-clean": "本地已删除",
};

/** sync 主命令 */
export async function syncCommand(opts: SyncOptions): Promise<void> {
  try {
    const outputDir = await resolveOutputDir(opts.output);
    const mode = await resolveMode(opts.mode as SyncMode | undefined);

    if (opts.mode && !ALL_MODES.includes(opts.mode as SyncMode)) {
      throw new Error(
        `未知模式：${opts.mode}。可选：${ALL_MODES.join(" / ")}`,
      );
    }

    const client = await getClient();
    logInfo(`🔁 同步模式：${mode}（${MODE_DESC[mode]}）`);

    const { plan, state, folders } = await buildSyncPlan(
      client,
      outputDir,
      mode,
      isJsonMode(),
    );

    if (plan.length === 0) {
      success({ outputDir, mode, changes: 0 }, () => {
        logInfo("✅ 已是最新，无需同步");
      });
      return;
    }

    // dry-run：只报告计划
    if (opts.dryRun) {
      const result = await executeSyncPlan(client, outputDir, mode, plan, state, folders, {
        dryRun: true,
        quiet: isJsonMode(),
      });
      success({ ...result, plan: planSummary(plan) }, () => {
        logInfo("📋 同步计划（dry-run，未执行）：");
        for (const it of plan) {
          logInfo(`  [${it.id}] ${it.subject} — ${describe(it)} → ${it.action}`);
        }
      });
      return;
    }

    // 冲突解决器：交互模式询问；非交互/--json 不提供 resolver（跳过并报告）
    const interactive = !isJsonMode() && process.stdout.isTTY && !opts.yes;
    const resolver = interactive ? makeInteractiveResolver() : undefined;

    const result = await executeSyncPlan(client, outputDir, mode, plan, state, folders, {
      quiet: isJsonMode(),
      resolveConflict: resolver,
    });

    success({ ...result, plan: planSummary(plan) }, () => {
      logInfo("\n📊 同步完成：");
      for (const [action, n] of Object.entries(result.applied)) {
        if (n > 0) logInfo(`  ${action}: ${n}`);
      }
      if (result.conflicts.length > 0) {
        logInfo(`\n⚠️  ${result.conflicts.length} 条冲突未处理（非交互环境已跳过，未改动数据）：`);
        for (const c of result.conflicts) {
          logInfo(`  [${c.id}] ${c.subject} — ${describe(c)}`);
        }
        logInfo("  可在交互式终端重跑 sync 逐条处理，或指定 --mode 决定优先方。");
      }
    });
  } catch (err) {
    fail(err);
  }
}

/** sync init：交互引导设置项目默认模式 */
export async function syncInitCommand(_opts: { output?: string }): Promise<void> {
  try {
    if (isJsonMode() || !process.stdout.isTTY) {
      throw new Error("init 需在交互式终端运行");
    }
    logInfo("🧭 mi-note-cli 同步初始化\n");
    logInfo("可选同步模式：");
    ALL_MODES.forEach((m, i) => {
      logInfo(`  ${i + 1}) ${m} — ${MODE_DESC[m]}`);
    });

    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const ask = (q: string): Promise<string> =>
      new Promise((res) => rl.question(q, res));

    const idxStr = await ask("\n选择默认模式 [1-5，默认 5 manual]: ");
    const idx = parseInt(idxStr.trim(), 10);
    const mode: SyncMode =
      idx >= 1 && idx <= ALL_MODES.length ? ALL_MODES[idx - 1] : "manual";

    await setMode(mode);
    rl.close();

    success({ mode, configPath: getUserConfigPath() }, () => {
      logInfo(`\n✅ 已将项目默认同步模式设为：${mode}`);
      logInfo(`   配置文件：${getUserConfigPath()}`);
      logInfo(`   提示：可在该文件中加 "output" 字段设置默认同步目录。`);
    });
  } catch (err) {
    fail(err);
  }
}

/** sync status：查看用户配置 + 当前 output 的同步状态 */
export async function syncStatusCommand(opts: { output?: string }): Promise<void> {
  try {
    const config = await loadUserConfig();
    const outputDir = await resolveOutputDir(opts.output);
    const state = await loadState(outputDir);

    success({ config, outputDir, state }, () => {
      logInfo(`配置文件：${getUserConfigPath()}`);
      logInfo(`同步模式：${config.mode ?? "manual（默认）"}`);
      if (config.output) logInfo(`默认目录：${config.output}`);
      if (config.fileNameTemplate) logInfo(`文件名模板：${config.fileNameTemplate}`);
      logInfo(`\n输出目录：${outputDir}`);
      logInfo(`状态文件：${getStatePath(outputDir)}`);
      const last = state.lastSync
        ? new Date(state.lastSync).toLocaleString("zh-CN")
        : "从未";
      logInfo(`笔记记录：${Object.keys(state.notes).length}  上次同步：${last}`);
    });
  } catch (err) {
    fail(err);
  }
}

// ---- 辅助 ----

function describe(it: SyncPlanItem): string {
  return SCENARIO_DESC[it.scenario] ?? it.scenario;
}

function planSummary(plan: SyncPlanItem[]) {
  return plan.map((it) => ({
    id: it.id,
    subject: it.subject,
    scenario: it.scenario,
    action: it.action,
  }));
}

/** 构造交互式冲突解决器 */
function makeInteractiveResolver() {
  return async (item: SyncPlanItem): Promise<SyncAction> => {
    logInfo(`\n⚠️  冲突 [${item.id}] ${item.subject}：${describe(item)}`);
    logInfo("  选择处理方式：");
    logInfo("  (l) 以本地为准（上行覆盖云端）");
    logInfo("  (r) 以云端为准（下行覆盖本地）");
    logInfo("  (s) 跳过");
    const ans = (await confirmChoice("  你的选择 [l/r/s，默认 s]: ")).toLowerCase();
    if (ans === "l") {
      return item.scenario === "local-deleted-remote-changed"
        ? "delete-remote"
        : "update-remote";
    }
    if (ans === "r") {
      return item.scenario === "remote-deleted-local-changed"
        ? "delete-local"
        : "update-local";
    }
    return "skip";
  };
}

/** 读取单行选择（复用 stdin） */
function confirmChoice(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stderr.write(question);
    const onData = (data: string): void => {
      process.stdin.pause();
      process.stdin.off("data", onData);
      resolve(data.trim());
    };
    process.stdin.resume();
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", onData);
  });
}
