import { getClient } from "./shared.js";
import { success, logInfo, fail } from "../output.js";
import type { WriteNoteEntry } from "../types.js";

/** 将笔记移动到指定文件夹（复用更新接口，改 folderId） */
export async function moveCommand(
  id: string,
  folderId: string,
): Promise<void> {
  try {
    const client = await getClient();
    const current = await client.getNote(id);

    if (String(current.folderId ?? "0") === folderId) {
      success({ id, folderId, moved: false }, () => {
        logInfo("笔记已在目标文件夹中");
      });
      return;
    }

    const entry: WriteNoteEntry = {
      id: String(current.id),
      tag: current.tag,
      status: current.status,
      createDate: current.createDate ?? Date.now(),
      modifyDate: Date.now(),
      colorId: current.colorId ?? 0,
      content: current.content ?? "",
      setting: current.setting,
      folderId,
      alertDate: current.alertDate ?? 0,
      extraInfo:
        typeof current.extraInfo === "string" ? current.extraInfo : undefined,
      subject: current.subject,
      snippet: current.snippet,
    };

    await client.updateNote(id, entry);

    success({ id, folderId, moved: true }, () => {
      logInfo(`✅ 笔记 ${id} 已移动到文件夹 ${folderId}`);
    });
  } catch (err) {
    fail(err);
  }
}
