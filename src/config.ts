import { readFile, writeFile } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { fileExists } from "./utils.js";
import type { AppConfig, SyncMode } from "./types.js";

/**
 * 配置随项目走：配置文件固定为「项目根」下的 `.mi-note-cli.json`，
 * 像 package.json / .gitignore 那样就近读取。CLI 在哪个目录执行，
 * 项目根即该目录（process.cwd()）。
 *
 * 允许用环境变量 MI_NOTE_CLI_CONFIG_DIR 覆盖项目根，便于测试隔离。
 */
const CONFIG_FILENAME = ".mi-note-cli.json";
const DEFAULT_MODE: SyncMode = "manual";

/** 项目根目录（配置文件与相对路径的基准） */
export function getProjectRoot(): string {
  return process.env.MI_NOTE_CLI_CONFIG_DIR || process.cwd();
}

/** 配置文件绝对路径 */
export function getConfigPath(): string {
  return join(getProjectRoot(), CONFIG_FILENAME);
}

/** 绝对路径 → 相对项目根（用于写入配置，保证跨机一致） */
export function toRelPath(absPath: string): string {
  return relative(getProjectRoot(), absPath);
}

/** 相对项目根的路径 → 绝对路径（用于实际文件读写） */
export function toAbsPath(relPath: string): string {
  return isAbsolute(relPath) ? relPath : resolve(getProjectRoot(), relPath);
}

/** 空配置壳 */
function emptyConfig(): AppConfig {
  return { mode: undefined, lastSync: null, notes: {}, folders: {} };
}

/** 读取项目本地配置（不存在则返回空壳） */
export async function loadConfig(): Promise<AppConfig> {
  const file = getConfigPath();
  if (!(await fileExists(file))) return emptyConfig();
  try {
    const raw = await readFile(file, "utf-8");
    const parsed = JSON.parse(raw) as Partial<AppConfig>;
    return {
      output: parsed.output,
      mode: parsed.mode,
      lastSync: parsed.lastSync ?? null,
      syncTag: parsed.syncTag,
      fileNameTemplate: parsed.fileNameTemplate,
      notes: parsed.notes ?? {},
      folders: parsed.folders ?? {},
    };
  } catch {
    return emptyConfig();
  }
}

/** 写入项目本地配置 */
export async function saveConfig(config: AppConfig): Promise<void> {
  await writeFile(getConfigPath(), JSON.stringify(config, null, 2), "utf-8");
}

/**
 * 读取同步状态。配置即状态——记录本次同步目录（相对项目根）后返回。
 */
export async function loadDirState(outputDir: string): Promise<AppConfig> {
  const config = await loadConfig();
  config.output = toRelPath(resolve(outputDir));
  return config;
}

/** 写回同步状态 */
export async function saveDirState(state: AppConfig): Promise<void> {
  await saveConfig(state);
}

/**
 * 解析生效的同步模式：命令行 > 项目配置 > 默认。
 */
export async function resolveMode(
  _outputDir: string,
  cliMode?: SyncMode,
): Promise<SyncMode> {
  if (cliMode) return cliMode;
  const config = await loadConfig();
  return config.mode ?? DEFAULT_MODE;
}

/** 设置项目的默认同步模式 */
export async function setMode(mode: SyncMode): Promise<void> {
  const config = await loadConfig();
  config.mode = mode;
  await saveConfig(config);
}

export const ALL_MODES: SyncMode[] = [
  "download",
  "mirror",
  "upload",
  "two-way",
  "manual",
];

export { DEFAULT_MODE };
