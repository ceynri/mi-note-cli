import { getClient, resolveContent } from "./shared.js";
import { markdownToXml, extractSnippet } from "../converter.js";
import { buildExtraInfoString } from "../note.js";
import { success, logInfo, fail } from "../output.js";
import type { WriteNoteEntry } from "../types.js";

interface CreateOptions {
  title?: string;
  folder?: string;
  color?: string;
  content?: string;
  file?: string;
}

/** 创建笔记 */
export async function createCommand(opts: CreateOptions): Promise<void> {
  try {
    const content = await resolveContent(opts);
    if (content === null || content.trim() === "") {
      throw new Error(
        "笔记内容为空。请通过 --content、--file 或标准输入（管道）提供内容。",
      );
    }

    const client = await getClient();
    const now = Date.now();
    const xmlContent = markdownToXml(content);

    const entry: WriteNoteEntry = {
      colorId: opts.color ? parseInt(opts.color, 10) : 0,
      folderId: opts.folder ?? "0",
      createDate: now,
      modifyDate: now,
      content: xmlContent,
      alertDate: 0,
      setting: { themeId: 0, stickyTime: 0, version: 0 },
      extraInfo: buildExtraInfoString(opts.title),
      snippet: extractSnippet(xmlContent),
    };

    const created = await client.createNote(entry);
    const id = String(created.id);

    success({ id, title: opts.title ?? "", folderId: entry.folderId }, () => {
      logInfo(`✅ 创建成功：${id}`);
    });
  } catch (err) {
    fail(err);
  }
}
