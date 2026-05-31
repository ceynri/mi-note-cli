import { getClient } from "./shared.js";
import { deriveTitle, xmlToMarkdown, truncateDisplay } from "../converter.js";
import { success, logInfo, fail } from "../output.js";
import type { NoteListItem, RawNoteEntry } from "../types.js";

interface ListOptions {
  folder?: string;
  limit?: string;
}

/** list 输出中单行标题的最大显示宽度（超出截断加省略号） */
const TITLE_MAX_WIDTH = 60;

/** 列出笔记 */
export async function listCommand(opts: ListOptions): Promise<void> {
  try {
    const client = await getClient();
    const { entries, folders } = await client.getAllNotes(200, (count: number) => {
      process.stderr.write(`\r📋 已获取 ${count} 条笔记...`);
    });
    process.stderr.write("\r");

    let filtered = entries;
    if (opts.folder) {
      filtered = filtered.filter(
        (e: RawNoteEntry) => String(e.folderId ?? "") === opts.folder,
      );
    }

    // 按修改时间倒序
    filtered.sort(
      (a: RawNoteEntry, b: RawNoteEntry) =>
        (b.modifyDate ?? 0) - (a.modifyDate ?? 0),
    );

    const limit = opts.limit ? parseInt(opts.limit, 10) : filtered.length;
    const sliced = filtered.slice(0, limit);

    const items: NoteListItem[] = sliced.map((e: RawNoteEntry) => toListItem(e));

    success(items, () => {
      if (items.length === 0) {
        logInfo("（无笔记）");
        return;
      }
      for (const it of items) {
        const time = it.modifyDate
          ? new Date(it.modifyDate).toLocaleString("zh-CN")
          : "";
        const folderName = it.folderId && it.folderId !== "0"
          ? folders[it.folderId]?.subject ?? it.folderId
          : "";
        const folderTag = folderName ? ` 📁${folderName}` : "";
        // 人类可读输出做显示截断，避免无标题笔记的长正文首行刷屏
        const title = truncateDisplay(it.title, TITLE_MAX_WIDTH);
        process.stdout.write(`[${it.id}] ${title}${folderTag}  (${time})\n`);
      }
      logInfo(`\n共 ${items.length} 条`);
    });
  } catch (err) {
    fail(err);
  }
}

function toListItem(e: RawNoteEntry): NoteListItem {
  return {
    id: String(e.id),
    // JSON 输出保留完整标题，截断只发生在人类可读渲染层
    title: deriveTitle(e),
    snippet: xmlToMarkdown(e.snippet ?? "").slice(0, 100),
    modifyDate: e.modifyDate,
    folderId: String(e.folderId ?? ""),
  };
}
