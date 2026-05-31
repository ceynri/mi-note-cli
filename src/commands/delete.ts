import { getClient } from "./shared.js";
import { parseNoteEntry } from "../converter.js";
import { isJsonMode, success, logInfo, fail, confirm } from "../output.js";


interface DeleteOptions {
  purge?: boolean;
  yes?: boolean;
}

/** 删除笔记（默认移回收站，--purge 永久删除） */
export async function deleteCommand(
  id: string,
  opts: DeleteOptions,
): Promise<void> {
  try {
    const client = await getClient();
    const entry = await client.getNote(id);
    const note = parseNoteEntry(entry);

    if (!entry.tag) {
      throw new Error("笔记缺少 tag 字段，无法删除");
    }

    if (!opts.yes && !isJsonMode()) {
      const action = opts.purge ? "永久删除" : "移到回收站";
      logInfo(`📝 笔记: ${note.subject || "(无标题)"} [${id}]`);
      const ok = await confirm(`确认要${action}该笔记吗？(y/N) `);
      if (!ok) {
        logInfo("已取消");
        return;
      }
    }

    await client.deleteNote(id, entry.tag, opts.purge ?? false);

    success({ id, purged: opts.purge ?? false }, () => {
      logInfo(
        opts.purge
          ? `✅ 笔记 ${id} 已永久删除`
          : `✅ 笔记 ${id} 已移到回收站（30 天内可在小米云服务网页端恢复）`,
      );
    });
  } catch (err) {
    fail(err);
  }
}
