import { readFile, writeFile } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { ensureFileDir, fileExists } from "./utils.js";
import type { SyncMode, UserConfig, SyncState } from "./types.js";

/**
 * 两类元数据按位置与归属拆分：
 *
 * - 用户配置：项目根 `.mi-note-cli/config.json`（手写、可入版控、可团队共享）
 * - 同步状态：`<outputDir>/.mi-note-cli.state.json`（自动生成、跟 output 1:1 绑定）
 *
 * `MI_NOTE_CLI_CONFIG_DIR` 环境变量可覆盖项目根，便于测试隔离。
 */
const CONFIG_DIRNAME = ".mi-note-cli";
const CONFIG_FILENAME = "config.json";
const STATE_FILENAME = ".mi-note-cli.state.json";
/** 默认 output 目录名（位于 .mi-note-cli/ 下，零配置时使用） */
const DEFAULT_OUTPUT_SUBDIR = "output";
const DEFAULT_SYNC_MODE: SyncMode = "manual";

// ============================================================
// 路径解析
// ============================================================

/** 项目根目录（用户配置与默认 output 的基准） */
export function getProjectRoot(): string {
  return process.env.MI_NOTE_CLI_CONFIG_DIR || process.cwd();
}

/** 用户配置文件绝对路径：`<root>/.mi-note-cli/config.json` */
export function getUserConfigPath(): string {
  return join(getProjectRoot(), CONFIG_DIRNAME, CONFIG_FILENAME);
}

/** 默认 output 目录绝对路径：`<root>/.mi-note-cli/output/` */
export function getDefaultOutputDir(): string {
  return join(getProjectRoot(), CONFIG_DIRNAME, DEFAULT_OUTPUT_SUBDIR);
}

/** 给定 output 目录，返回其内的 state 文件绝对路径 */
export function getStatePath(outputDir: string): string {
  return join(outputDir, STATE_FILENAME);
}

/** 绝对路径 → 相对 output（用于写入 state.notes[].filePath） */
export function toOutputRel(absPath: string, outputDir: string): string {
  return relative(outputDir, absPath);
}

/** 相对 output 的路径 → 绝对路径（用于实际文件读写） */
export function toOutputAbs(relPath: string, outputDir: string): string {
  return isAbsolute(relPath) ? relPath : resolve(outputDir, relPath);
}

// ============================================================
// 用户配置（UserConfig）
// ============================================================

function emptyUserConfig(): UserConfig {
  return {};
}

/**
 * 读取项目用户配置（不存在则返回空壳；不读旧 .mi-note-cli.json 兼容）。
 *
 * 回落形态：返回 `{}`（全字段 undefined）。消费者通过 `??` 链回落到默认值；
 * 显式 syncMode/output/fileNameTemplate 白名单也防止旧字段（如 lastSync/notes）误漂进 UserConfig。
 * 与 `loadState` 的容错风格刻意不同：state 由工具自动写入，schema 漂移可控。
 */
export async function loadUserConfig(): Promise<UserConfig> {
  const file = getUserConfigPath();
  if (!(await fileExists(file))) return emptyUserConfig();
  try {
    const raw = await readFile(file, "utf-8");
    const parsed = JSON.parse(raw) as Partial<UserConfig>;
    return {
      syncMode: parsed.syncMode,
      output: parsed.output,
      fileNameTemplate: parsed.fileNameTemplate,
    };
  } catch {
    return emptyUserConfig();
  }
}

/** 写入用户配置（自动创建 .mi-note-cli 父目录） */
export async function saveUserConfig(cfg: UserConfig): Promise<void> {
  const file = getUserConfigPath();
  await ensureFileDir(file);
  await writeFile(file, JSON.stringify(cfg, null, 2), "utf-8");
}

// ============================================================
// 同步状态（SyncState）
// ============================================================

function emptyState(): SyncState {
  return { lastSync: null, notes: {}, folders: {} };
}

/**
 * 读取指定 output 内的同步状态；不存在或解析失败时返回空壳。
 *
 * 回落形态与 `loadUserConfig` 不同：state 是「数据载体」，消费者要直接遍历
 * `notes`/`folders`，因此回落到带空容器的对象（`{ lastSync: null, notes: {}, folders: {} }`）；
 * 而 `loadUserConfig` 回落到全字段 undefined（消费者用 `??` 链回落到默认值）。
 */
export async function loadState(outputDir: string): Promise<SyncState> {
  const file = getStatePath(outputDir);
  if (!(await fileExists(file))) return emptyState();
  try {
    const raw = await readFile(file, "utf-8");
    const parsed = JSON.parse(raw) as Partial<SyncState>;
    return {
      lastSync: parsed.lastSync ?? null,
      syncTag: parsed.syncTag,
      notes: parsed.notes ?? {},
      folders: parsed.folders ?? {},
    };
  } catch {
    return emptyState();
  }
}

/** 写回同步状态（自动创建父目录，幂等） */
export async function saveState(
  outputDir: string,
  state: SyncState,
): Promise<void> {
  const file = getStatePath(outputDir);
  await ensureFileDir(file);
  await writeFile(file, JSON.stringify(state, null, 2), "utf-8");
}

// ============================================================
// 解析（output / mode）
// ============================================================

/**
 * 解析生效的 output 目录（绝对路径）。
 * 优先级：CLI `-o <dir>` > UserConfig.output > `<root>/.mi-note-cli/output/`
 *
 * 相对路径基准：
 * - CLI `-o`：基于 `process.cwd()`（用户在终端的当前位置，符合 Unix 工具约定）
 * - UserConfig.output：基于项目根（配置文件所在位置）
 * - 默认值：基于项目根
 *
 * 两种基准刻意不同：CLI 参数遵循 pwd 直觉，配置字段遵循「相对配置文件」直觉。
 */
export async function resolveOutputDir(cliOutput?: string): Promise<string> {
  if (cliOutput) return resolve(cliOutput);
  const cfg = await loadUserConfig();
  if (cfg.output) {
    return isAbsolute(cfg.output)
      ? cfg.output
      : resolve(getProjectRoot(), cfg.output);
  }
  return getDefaultOutputDir();
}

/** 解析生效的同步模式：CLI > 用户配置 > 默认 */
export async function resolveSyncMode(cliMode?: SyncMode): Promise<SyncMode> {
  if (cliMode) return cliMode;
  const cfg = await loadUserConfig();
  return cfg.syncMode ?? DEFAULT_SYNC_MODE;
}

/** 设置默认同步模式（写入用户配置） */
export async function setSyncMode(mode: SyncMode): Promise<void> {
  const cfg = await loadUserConfig();
  cfg.syncMode = mode;
  await saveUserConfig(cfg);
}

/** 设置默认 output 目录（写入用户配置） */
export async function setOutput(output: string): Promise<void> {
  const cfg = await loadUserConfig();
  cfg.output = output;
  await saveUserConfig(cfg);
}

export const ALL_MODES: SyncMode[] = [
  "cloud-first",
  "local-first",
  "two-way",
  "manual",
];

export { DEFAULT_SYNC_MODE };
