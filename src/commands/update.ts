import { getClient, resolveContent, contentBaseDir } from "./shared.js";
import {
  markdownToXml,
  extractSnippet,
  parseNoteEntry,
  buildImageMap,
} from "../converter.js";
import { uploadLocalImages, withAttachments } from "../images.js";
import { buildExtraInfoString } from "../note.js";
import { success, logInfo, fail } from "../output.js";
import type { WriteNoteEntry } from "../types.js";

interface UpdateOptions {
  title?: string;
  folder?: string;
  color?: string;
  content?: string;
  file?: string;
}

/**
 * 更新笔记。先 GET 拿到最新 tag（乐观锁），改字段后再提交。
 * 若未提供新内容，则保留原内容（仅改 title/folder/color 等元数据）。
 */
export async function updateCommand(
  id: string,
  opts: UpdateOptions,
): Promise<void> {
  try {
    let colorOverride: number | undefined;
    if (opts.color !== undefined) {
      colorOverride = parseInt(opts.color, 10);
      if (Number.isNaN(colorOverride)) {
        throw new Error(`--color 必须是数字，收到：${opts.color}`);
      }
    }

    const client = await getClient();
    const current = await client.getNote(id);

    const newContent = await resolveContent(opts);
    let xmlContent = current.content ?? "";
    let setting = current.setting ?? { themeId: 0, stickyTime: 0, version: 0 };
    if (newContent !== null) {
      // get / sync 写出的附件引用按当前笔记附件还原，内容可原样 get → 改 → update；新的本地图片自动上传
      const known = buildImageMap(parseNoteEntry(current).files, "assets/", "../assets/");
      const { imageMap, uploaded } = await uploadLocalImages(
        client,
        newContent,
        known,
        [contentBaseDir(opts)],
      );
      xmlContent = markdownToXml(newContent, imageMap);
      setting = withAttachments(setting, uploaded);
    }

    const now = Date.now();
    const entry: WriteNoteEntry = {
      id: String(current.id),
      tag: current.tag,
      status: current.status,
      createDate: current.createDate ?? now,
      modifyDate: now,
      colorId: colorOverride ?? current.colorId ?? 0,
      content: xmlContent,
      setting,
      folderId: opts.folder ?? String(current.folderId ?? "0"),
      alertDate: current.alertDate ?? 0,
      extraInfo: buildExtraInfoString(opts.title, normalizeExtraInfo(current.extraInfo)),
      subject: current.subject,
      snippet: extractSnippet(xmlContent),
    };

    await client.updateNote(id, entry);

    success({ id, updated: true }, () => {
      logInfo(`✅ 笔记 ${id} 更新完成`);
    });
  } catch (err) {
    fail(err);
  }
}

/** extraInfo 可能是 string 或对象，统一为 string 传给 buildExtraInfoString */
function normalizeExtraInfo(
  raw: string | Record<string, unknown> | undefined,
): string | undefined {
  if (raw === undefined) return undefined;
  return typeof raw === "string" ? raw : JSON.stringify(raw);
}
