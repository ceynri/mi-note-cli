import { parseExtraInfo } from "./converter.js";

/** 笔记 extraInfo 字段结构 */
export interface NoteExtraInfo {
  title?: string;
  note_content_type?: string;
  web_images?: string;
  mind_content?: string;
  mind_content_plain_text?: string;
}

/**
 * 构造 extraInfo JSON 字符串。
 * - 保留已有字段（更新场景），仅覆盖 title。
 * - 默认 note_content_type 为 "common"。
 */
export function buildExtraInfoString(
  title: string | undefined,
  existing?: string,
): string | undefined {
  const base = parseExtraInfo(existing) as NoteExtraInfo;
  const info: NoteExtraInfo = {
    note_content_type: base.note_content_type ?? "common",
    title: base.title,
    web_images: base.web_images,
    mind_content: base.mind_content,
    mind_content_plain_text: base.mind_content_plain_text,
  };
  if (title !== undefined) {
    info.title = title;
  }
  const entries = Object.entries(info).filter(
    ([, v]) => v !== undefined && v !== "",
  );
  if (entries.length === 0) return undefined;
  return JSON.stringify(Object.fromEntries(entries));
}
