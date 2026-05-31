/**
 * 统一输出层：支持人类可读输出与 --json 机器可读输出。
 *
 * 设计约定：
 * - 所有结构化结果走 stdout（JSON 模式输出纯 JSON，便于 AI/管道解析）。
 * - 所有日志、进度、提示走 stderr（不污染 stdout 结果）。
 */

let jsonMode = false;

export function setJsonMode(enabled: boolean): void {
  jsonMode = enabled;
}

export function isJsonMode(): boolean {
  return jsonMode;
}

/** 输出一条日志/进度到 stderr */
export function logInfo(message: string): void {
  process.stderr.write(message + "\n");
}

/**
 * 输出成功结果。
 * - JSON 模式：输出 { ok: true, data }
 * - 普通模式：调用 humanRender 渲染
 */
export function success(data: unknown, humanRender: () => void): void {
  if (jsonMode) {
    process.stdout.write(JSON.stringify({ ok: true, data }, null, 2) + "\n");
  } else {
    humanRender();
  }
}

/** 输出纯文本结果（如笔记 Markdown 内容），JSON 模式下包进 data */
export function output(text: string, jsonKey = "content"): void {
  if (jsonMode) {
    process.stdout.write(
      JSON.stringify({ ok: true, data: { [jsonKey]: text } }, null, 2) + "\n",
    );
  } else {
    process.stdout.write(text + "\n");
  }
}

/** 输出错误并以非零码退出 */
export function fail(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (jsonMode) {
    process.stdout.write(
      JSON.stringify({ ok: false, error: message }, null, 2) + "\n",
    );
  } else {
    process.stderr.write(`❌ ${message}\n`);
  }
  process.exit(1);
}

/** 命令行 y/N 确认提示（问题走 stderr，不污染 stdout） */
export function confirm(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    process.stderr.write(question);
    const stdin = process.stdin;
    stdin.setEncoding("utf-8");
    const onData = (data: string) => {
      stdin.pause();
      stdin.off("data", onData);
      resolve(data.trim().toLowerCase() === "y");
    };
    stdin.resume();
    stdin.on("data", onData);
  });
}

/**
 * 从 stdin 读取全部输入（用于 create/update 从管道接收内容）。
 * 若 stdin 是 TTY（无管道输入）返回 null。
 */
export async function readStdin(): Promise<string | null> {
  if (process.stdin.isTTY) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf-8");
  return text.length > 0 ? text : null;
}
