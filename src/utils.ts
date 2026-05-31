import { mkdir, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir, platform } from "node:os";

const APP_NAME = "mi-note-cli";

/**
 * 清理文件名中的非法字符
 */
export function sanitizeFileName(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .replace(/[.\s]+$/, "")
    .trim()
    .slice(0, 200);
}

/** 延时 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 带随机抖动的延时（模拟人类节奏，降低风控概率） */
export function randomDelay(baseMs: number, jitterRatio = 0.5): Promise<void> {
  const jitter = baseMs * jitterRatio * (2 * Math.random() - 1);
  return delay(Math.max(50, Math.round(baseMs + jitter)));
}

/** 格式化为 YYYY-MM-DD_HH-mm-ss */
export function formatDateTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, "0");
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  return `${date}_${time}`;
}

/** 确保目录存在 */
export async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

/** 检查文件是否存在 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** 确保文件所在目录存在 */
export async function ensureFileDir(filePath: string): Promise<void> {
  await ensureDir(dirname(filePath));
}

/**
 * 获取全局缓存目录（跨平台）——仅存放 cookie / 浏览器数据等可重建的缓存。
 *
 * - macOS:   ~/Library/Caches/mi-note-cli/
 * - Linux:   $XDG_CACHE_HOME/mi-note-cli/ 或 ~/.cache/mi-note-cli/
 * - Windows: %LOCALAPPDATA%/mi-note-cli/cache/
 */
export function getCacheDir(app: string = APP_NAME): string {
  const home = homedir();
  switch (platform()) {
    case "darwin":
      return join(home, "Library", "Caches", app);
    case "win32":
      return join(
        process.env.LOCALAPPDATA || join(home, "AppData", "Local"),
        app,
        "cache",
      );
    default:
      return join(process.env.XDG_CACHE_HOME || join(home, ".cache"), app);
  }
}

/** 推断图片 MIME 类型 */
export function inferImageMimeType(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".bmp")) return "image/bmp";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}
