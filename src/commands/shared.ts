import { readFile } from "node:fs/promises";
import { ensureAuth, peekOrRefreshAuth, refreshAuth } from "../auth.js";
import { MiNoteClient } from "../client.js";
import { readStdin, isJsonMode } from "../output.js";

/**
 * 获取已认证的 API 客户端。
 *
 * - 默认（交互式终端）：无有效登录态时会触发浏览器登录。
 * - JSON 模式或非交互式（无 TTY，如被 AI/脚本调用）：不弹浏览器，
 *   直接抛出清晰的「请先登录」错误，避免进程挂起等待人工登录。
 *
 * 所有客户端都注入 refreshAuth 作为续期回调：请求遇 401 时静默用
 * 持久化的长效登录态换发新 serviceToken 并重试，无需重新弹浏览器。
 */
export async function getClient(forceLogin = false): Promise<MiNoteClient> {
  const nonInteractive = isJsonMode() || !process.stdout.isTTY;

  if (nonInteractive && !forceLogin) {
    // 先看现有登录态；已过期则尝试静默续期（用持久化长效凭证换新），
    // 仍失败才要求人工 login——避免非交互场景因 token 短效频繁中断。
    const auth = await peekOrRefreshAuth();
    if (!auth) {
      throw new Error(
        "未登录或登录态已过期。请先在交互式终端运行 `mi-note-cli login` 完成登录。",
      );
    }
    return new MiNoteClient(auth, refreshAuth);
  }

  const auth = await ensureAuth(forceLogin);
  return new MiNoteClient(auth, refreshAuth);
}

/**
 * 解析笔记内容来源：优先级 --content > --file > stdin。
 * 返回内容字符串；若都没有则返回 null。
 */
export async function resolveContent(opts: {
  content?: string;
  file?: string;
}): Promise<string | null> {
  if (opts.content !== undefined) return opts.content;
  if (opts.file) {
    return await readFile(opts.file, "utf-8");
  }
  return await readStdin();
}
