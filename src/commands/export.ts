import { getClient } from "./shared.js";
import { exportNotes } from "../sync.js";
import { resolveOutputDir } from "../config.js";
import { isJsonMode, success, fail } from "../output.js";

interface ExportOptions {
  output?: string;
  force?: boolean;
}

/** 导出笔记到本地 Markdown（单向云→本地，永不修改云端） */
export async function exportCommand(opts: ExportOptions): Promise<void> {
  try {
    const outputDir = await resolveOutputDir(opts.output);
    const client = await getClient();
    const result = await exportNotes(
      client,
      outputDir,
      opts.force ?? false,
      isJsonMode(),
    );
    success(result, () => {
      // 过程已打印汇总
    });
  } catch (err) {
    fail(err);
  }
}
