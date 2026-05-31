import { getClient } from "./shared.js";
import { deriveTitle, xmlToMarkdown } from "../converter.js";
import { success, logInfo, fail } from "../output.js";
import type { NoteListItem, RawNoteEntry } from "../types.js";

interface SearchOptions {
  limit?: string;
}

/** 关键词搜索笔记（匹配标题与摘要，不区分大小写） */
export async function searchCommand(
  keyword: string,
  opts: SearchOptions,
): Promise<void> {
  try {
    const client = await getClient();
    const { entries } = await client.getAllNotes(200, (count: number) => {
      process.stderr.write(`\r🔍 已检索 ${count} 条...`);
    });
    process.stderr.write("\r");

    const kw = keyword.toLowerCase();
    const matches = entries.filter((e: RawNoteEntry) => {
      const title = deriveTitle(e).toLowerCase();
      const snippet = xmlToMarkdown(e.snippet ?? "").toLowerCase();
      return title.includes(kw) || snippet.includes(kw);
    });

    matches.sort(
      (a: RawNoteEntry, b: RawNoteEntry) =>
        (b.modifyDate ?? 0) - (a.modifyDate ?? 0),
    );
    const limit = opts.limit ? parseInt(opts.limit, 10) : 20;
    const sliced = matches.slice(0, limit);

    const items: NoteListItem[] = sliced.map((e: RawNoteEntry) => ({
      id: String(e.id),
      title: deriveTitle(e),
      snippet: xmlToMarkdown(e.snippet ?? "").slice(0, 100),
      modifyDate: e.modifyDate,
      folderId: String(e.folderId ?? ""),
    }));

    success(items, () => {
      if (items.length === 0) {
        logInfo("未找到匹配的笔记");
        return;
      }
      items.forEach((it, i) => {
        const time = it.modifyDate
          ? new Date(it.modifyDate).toLocaleString("zh-CN")
          : "";
        process.stdout.write(`${i + 1}. [${it.id}] ${it.title}  (${time})\n`);
      });
      logInfo(`\n共 ${items.length} 条匹配`);
    });
  } catch (err) {
    fail(err);
  }
}
