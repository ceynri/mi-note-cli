import { readFile, writeFile } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { getConfigDir, ensureDir, fileExists } from "./utils.js";
import type { AppConfig, SyncDirState, SyncMode } from "./types.js";

/**
 * 配置文件路径。允许用环境变量 MI_NOTE_CLI_CONFIG_DIR 覆盖配置目录，
 * 便于测试隔离（不污染真实公共配置）。
 */
function configFilePath(): string {
  const override = process.env.MI_NOTE_CLI_CONFIG_DIR;
  return join(override || getConfigDir(), "config.json");
}

const DEFAULT_MODE: SyncMode = "manual";

/** 读取公共配置（不存在则返回空壳） */
export async function loadConfig(): Promise<AppConfig> {
  const file = configFilePath();
  if (!(await fileExists(file))) {
    return { syncs: {} };
  }
  try {
    const raw = await readFile(file, "utf-8");
    const parsed = JSON.parse(raw) as Partial<AppConfig>;
    return { mode: parsed.mode, syncs: parsed.syncs ?? {} };
  } catch {
    return { syncs: {} };
  }
}

/** 写入公共配置 */
export async function saveConfig(config: AppConfig): Promise<void> {
  const file = configFilePath();
  await ensureDir(dirname(file));
  await writeFile(file, JSON.stringify(config, null, 2), "utf-8");
}

/** 配置文件绝对路径（用于提示用户） */
export function getConfigPath(): string {
  return configFilePath();
}

/** 把输出目录归一化为绝对路径，作为 syncs 的 key */
export function normalizeOutputKey(outputDir: string): string {
  return resolve(outputDir);
}

/** 读取某输出目录的同步状态（不存在则返回空状态） */
export async function loadDirState(outputDir: string): Promise<SyncDirState> {
  const key = normalizeOutputKey(outputDir);
  const config = await loadConfig();
  return (
    config.syncs[key] ?? {
      output: key,
      lastSync: null,
      notes: {},
      folders: {},
    }
  );
}

/** 写回某输出目录的同步状态（合并进公共配置） */
export async function saveDirState(state: SyncDirState): Promise<void> {
  const config = await loadConfig();
  config.syncs[normalizeOutputKey(state.output)] = state;
  await saveConfig(config);
}

/**
 * 解析生效的同步模式：命令行 > 该目录配置 > 全局配置 > 默认。
 */
export async function resolveMode(
  outputDir: string,
  cliMode?: SyncMode,
): Promise<SyncMode> {
  if (cliMode) return cliMode;
  const config = await loadConfig();
  const dirState = config.syncs[normalizeOutputKey(outputDir)];
  return dirState?.mode ?? config.mode ?? DEFAULT_MODE;
}

/** 设置全局默认模式 */
export async function setGlobalMode(mode: SyncMode): Promise<void> {
  const config = await loadConfig();
  config.mode = mode;
  await saveConfig(config);
}

/** 设置某目录的模式 */
export async function setDirMode(
  outputDir: string,
  mode: SyncMode,
): Promise<void> {
  const state = await loadDirState(outputDir);
  state.mode = mode;
  await saveDirState(state);
}

export const ALL_MODES: SyncMode[] = [
  "download",
  "mirror",
  "upload",
  "two-way",
  "manual",
];

export { DEFAULT_MODE };
