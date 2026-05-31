import { getClient } from "./shared.js";
import { success, logInfo, fail } from "../output.js";
import type { WriteNoteEntry } from "../types.js";

/**
 * 置顶 / 取消置顶笔记。
 *
 * 置顶通过 setting.stickyTime 实现：>0 表示置顶（用当前时间戳），0 表示取消。
 */
export async function pinCommand(id: string, pin: boolean): Promise<void> {
  try {
    const client = await getClient();
    const current = await client.getNote(id);

    const stickyTime = pin ? Date.now() : 0;
    const entry: WriteNoteEntry = {
      id: String(current.id),
      tag: current.tag,
      status: current.status,
      createDate: current.createDate ?? Date.now(),
      modifyDate: Date.now(),
      colorId: current.colorId ?? 0,
      content: current.content ?? "",
      setting: {
        themeId: current.setting?.themeId ?? 0,
        stickyTime,
        version: current.setting?.version ?? 0,
        data: current.setting?.data,
      },
      folderId: String(current.folderId ?? "0"),
      alertDate: current.alertDate ?? 0,
      extraInfo:
        typeof current.extraInfo === "string" ? current.extraInfo : undefined,
      subject: current.subject,
      snippet: current.snippet,
    };

    await client.updateNote(id, entry);

    success({ id, pinned: pin }, () => {
      logInfo(pin ? `✅ 笔记 ${id} 已置顶` : `✅ 笔记 ${id} 已取消置顶`);
    });
  } catch (err) {
    fail(err);
  }
}
