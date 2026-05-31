import { getClient } from "./shared.js";
import { parseNoteEntry, xmlToMarkdown, deriveTitle } from "../converter.js";
import { isJsonMode, output, success, fail } from "../output.js";

interface GetOptions {
  raw?: boolean;
}

/** 获取单条笔记内容 */
export async function getCommand(id: string, opts: GetOptions): Promise<void> {
  try {
    const client = await getClient();
    const entry = await client.getNote(id);

    if (opts.raw) {
      // 输出原始 XML 内容
      output(entry.content ?? "", "content");
      return;
    }

    const parsed = parseNoteEntry(entry);
    const markdown = xmlToMarkdown(parsed.content, parsed.files);
    const title = deriveTitle(entry);

    if (isJsonMode()) {
      success(
        {
          id: parsed.id,
          title,
          folderId: parsed.folderId,
          createDate: parsed.createDate,
          modifyDate: parsed.modifyDate,
          content: markdown,
          files: parsed.files.map((f) => ({ fileId: f.fileId, name: f.name })),
        },
        () => {},
      );
    } else {
      output(markdown, "content");
    }
  } catch (err) {
    fail(err);
  }
}
