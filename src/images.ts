import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { MiNoteClient } from "./client.js";
import {
  listImageTargets,
  isLocalImageTarget,
  assertAttachmentsResolvable,
} from "./converter.js";
import { inferImageMimeType } from "./utils.js";
import type { NoteSetting, RawNoteFile } from "./types.js";

/**
 * 上传 Markdown 里引用的本地图片，返回可交给 markdownToXml 的 imageMap，
 * 以及需要登记到笔记 setting.data 的附件（小米客户端靠它识别图片类型）。
 *
 * 先按「本地图片都能上传」做一次附件守护再真正上传，避免因其他问题中止时留下无用的上传。
 *
 * @param imageMap 已知引用 → fileId（如当前笔记已有附件）
 * @param baseDirs 解析相对路径的基准目录，按顺序查找
 */
export async function uploadLocalImages(
  client: Pick<MiNoteClient, "uploadImage">,
  markdown: string,
  imageMap: Map<string, string>,
  baseDirs: string[],
): Promise<{ imageMap: Map<string, string>; uploaded: RawNoteFile[] }> {
  const pending = new Map<string, string>();
  for (const target of listImageTargets(markdown)) {
    if (!isLocalImageTarget(target) || imageMap.has(target) || pending.has(target)) continue;
    const path = await findLocalImage(target, baseDirs);
    if (path) pending.set(target, path);
  }

  const provisional = new Map(imageMap);
  for (const target of pending.keys()) provisional.set(target, "pending");
  assertAttachmentsResolvable(markdown, provisional);

  const result = new Map(imageMap);
  const uploaded: RawNoteFile[] = [];
  const fileIdByPath = new Map<string, string>();
  for (const [target, path] of pending) {
    let fileId = fileIdByPath.get(path);
    if (!fileId) {
      const mimeType = inferImageMimeType(path);
      const buffer = new Uint8Array(await readFile(path));
      const res = await client.uploadImage(buffer, { filename: basename(path), mimeType });
      fileId = res.fileId;
      fileIdByPath.set(path, fileId);
      uploaded.push({ fileId, digest: res.digest, mimeType });
    }
    result.set(target, fileId);
  }
  return { imageMap: result, uploaded };
}

/** 把新上传的附件追加进 setting.data（已存在的 fileId 不重复登记） */
export function withAttachments(
  setting: NoteSetting | undefined,
  uploaded: RawNoteFile[],
): NoteSetting {
  const base = setting ?? { themeId: 0, stickyTime: 0, version: 0 };
  if (uploaded.length === 0) return base;
  const existing = base.data ?? [];
  const known = new Set(existing.map((f) => f.fileId));
  return {
    ...base,
    data: [...existing, ...uploaded.filter((f) => !known.has(f.fileId))],
  };
}

/** 解析 Markdown 图片 target 为本地图片文件路径；不存在或不是图片时返回 undefined */
async function findLocalImage(
  target: string,
  baseDirs: string[],
): Promise<string | undefined> {
  // 去掉可选标题 `path "title"` 与尖括号 `<path with space>`
  let raw = target.replace(/\s+"[^"]*"$/, "").trim();
  if (raw.startsWith("<") && raw.endsWith(">")) raw = raw.slice(1, -1);
  const candidates = new Set([raw]);
  try {
    candidates.add(decodeURIComponent(raw));
  } catch {
    // 非法百分号编码，按原样查找
  }

  for (const dir of baseDirs) {
    for (const c of candidates) {
      const path = resolve(dir, c);
      if (!inferImageMimeType(path).startsWith("image/")) continue;
      try {
        if ((await stat(path)).isFile()) return path;
      } catch {
        // 不存在，继续找
      }
    }
  }
  return undefined;
}
