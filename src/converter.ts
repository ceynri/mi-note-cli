import { join } from "node:path";
import { formatDateTime, sanitizeFileName } from "./utils.js";
import type {
  RawNoteEntry,
  RawFolderEntry,
  ParsedNote,
  NoteFile,
} from "./types.js";

// ============================================================
// 小米云笔记内容格式：自有的类 XML 标记（非标准 HTML）
// 本模块提供 XML → Markdown（用于读取/导出）
//        与 Markdown → XML（用于创建/更新）双向转换。
// ============================================================

interface ParsedLine {
  type: string;
  text: string;
}

const MIME_CATEGORY_MAP: Record<
  string,
  { type: string; defaultSuffix: string }
> = {
  image: { type: "img", defaultSuffix: "jpg" },
  audio: { type: "audio", defaultSuffix: "mp3" },
  video: { type: "video", defaultSuffix: "mp4" },
};

const MEDIA_TAG_FORMATS: {
  tag: string;
  format: (name: string, path: string) => string;
}[] = [
  { tag: "img", format: (name, path) => `![${name}](${path})` },
  { tag: "sound", format: (name, path) => `[🔊 ${name}](${path})` },
  { tag: "video", format: (name, path) => `[🎬 ${name}](${path})` },
];

const HEADING_TAGS: {
  tag: string;
  prefix: string;
  matchRegex: RegExp;
  inlineRegex: RegExp;
}[] = [
  { tag: "size", prefix: "#" },
  { tag: "mid-size", prefix: "##" },
  { tag: "h3-size", prefix: "###" },
].map(({ tag, prefix }) => ({
  tag,
  prefix,
  matchRegex: new RegExp(`^<${tag}>([\\s\\S]*?)</${tag}>$`),
  inlineRegex: new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"),
}));

const LIST_TYPES = ["checkbox", "bullet", "order"];

// ============ 解析原始 entry ============

/** 解析 extraInfo（可能是 JSON 字符串或对象） */
export function parseExtraInfo(
  raw: string | Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** 派生笔记标题（extraInfo.title > subject > 内容首行 > 创建时间） */
export function deriveTitle(note: RawNoteEntry): string {
  const extra = parseExtraInfo(note.extraInfo);
  const extraTitle = (extra.title as string)?.trim();
  if (extraTitle) return extraTitle;
  if (note.subject?.trim()) return note.subject.trim();

  const firstLine = xmlToMarkdown(note.snippet ?? note.content ?? "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (firstLine) return firstLine;

  return formatDateTime(note.createDate || Date.now());
}

/** 解析原始 entry 为领域模型 */
export function parseNoteEntry(note: RawNoteEntry): ParsedNote {
  const id = String(note.id);
  const folderId = String(note.folderId || "");
  const extra = parseExtraInfo(note.extraInfo);

  let content = note.content || note.snippet || "";
  if (extra.mind_content) {
    content = extra.mind_content as string;
  }

  const subject = sanitizeFileName(deriveTitle(note));
  const files = parseNoteFiles(note);

  return {
    id,
    folderId,
    subject,
    content,
    files,
    createDate: note.createDate,
    modifyDate: note.modifyDate,
    contentType: (extra.note_content_type as string) || "note",
  };
}

function parseNoteFiles(note: RawNoteEntry): NoteFile[] {
  const rawFiles = note.setting?.data || note.files || [];
  if (!Array.isArray(rawFiles)) return [];
  return rawFiles.map((file) => {
    const rawId = file.rawId || file.fileId || file.digest || "";
    const mimeType = file.mimeType || "";
    const dotIndex = rawId.indexOf(".");
    const id = dotIndex >= 0 ? rawId.slice(dotIndex + 1) : rawId;
    const { type, suffix } = inferFileType(mimeType);
    const dateStr = formatDateTime(note.createDate || Date.now());
    const name = `${type}_${dateStr}_${id.slice(-8)}.${suffix}`;
    return { rawId, name, id, type, suffix, fileId: rawId };
  });
}

function inferFileType(mimeType: string): { type: string; suffix: string } {
  const [category, subtype] = mimeType.split("/");
  const mapping = MIME_CATEGORY_MAP[category];
  if (!mapping) return { type: "file", suffix: "bin" };
  let suffix = subtype || mapping.defaultSuffix;
  if (suffix === "jpeg") suffix = "jpg";
  return { type: mapping.type, suffix };
}

// ============ XML → Markdown ============

/**
 * 将笔记 XML 内容转换为 Markdown（逐行解析）。
 * @param content 原始 XML 内容
 * @param files   附件列表（用于替换 <img>/<sound>/<video> 标记为本地路径）
 * @param assetPrefix 附件路径前缀（默认 "assets/"，传入 "minote://image/" 等可定制）
 */
export function xmlToMarkdown(
  content: string,
  files: NoteFile[] = [],
  assetPrefix = "assets/",
): string {
  if (!content) return "";
  let text = content.replace(/\r\n/g, "\n");

  // 预处理：替换附件标记
  text = replaceAttachments(text, files, assetPrefix);
  // 移除格式标记
  text = text.replace(/<new-format\s*\/>/g, "");
  text = text.replace(/<0\/>/g, "");

  const lines = text.split("\n");
  const mdLines: string[] = [];
  let prevType = "";

  for (const line of lines) {
    const parsed = parseLine(line.trim());
    if (parsed === null) continue;
    if (mdLines.length > 0 && needsBlankLine(prevType, parsed.type)) {
      mdLines.push("");
    }
    mdLines.push(parsed.text);
    prevType = parsed.type;
  }

  let result = mdLines.join("\n");
  result = result.replace(/\n{3,}/g, "\n\n");
  return result.trim();
}

/**
 * 将已解析的笔记转换为 Markdown（便捷封装）。
 * 会用解析出的附件列表把 <img>/<sound>/<video> 标记替换为 assets/ 本地路径。
 */
export function noteToMarkdown(note: ParsedNote): string {
  return xmlToMarkdown(note.content, note.files, "assets/");
}

function needsBlankLine(prevType: string, currType: string): boolean {
  if (!prevType) return false;
  if (prevType === currType && LIST_TYPES.includes(currType)) return false;
  if (prevType === "text" && currType === "text") return true;
  const blockTypes = ["heading", "hr", "quote"];
  if (blockTypes.includes(currType) || blockTypes.includes(prevType)) return true;
  if (LIST_TYPES.includes(prevType) !== LIST_TYPES.includes(currType)) return true;
  return false;
}

function parseLine(line: string): ParsedLine | null {
  if (!line) return { type: "blank", text: "" };

  if (/^<hr\s*\/>$/.test(line)) return { type: "hr", text: "---" };

  // 复选框（可能自闭合后跟文本，或包裹文本）
  const checkboxMatch = line.match(
    /^<input\s+([^>]*?)type="checkbox"([^>]*?)\s*\/>(.*)$/,
  );
  if (checkboxMatch) {
    const attrs = checkboxMatch[1] + checkboxMatch[2];
    const indentMatch = attrs.match(/indent="(\d+)"/);
    const checkedMatch = attrs.match(/checked="(true|false)"/);
    const indent = getIndentLevel(indentMatch?.[1]);
    const checked = checkedMatch?.[1] === "true";
    const inner = stripTrailingTags(checkboxMatch[3]).trim();
    const txt = convertInlineStyles(inner);
    const spaces = "  ".repeat(indent);
    return { type: "checkbox", text: `${spaces}- [${checked ? "x" : " "}] ${txt}` };
  }

  const orderMatch = line.match(
    /^<order(?:\s+indent="(\d+)")?\s*>([\s\S]*?)<\/order>$/,
  );
  if (orderMatch) return formatListItem("order", "1.", orderMatch[1], orderMatch[2]);

  const bulletMatch = line.match(
    /^<bullet(?:\s+indent="(\d+)")?\s*>([\s\S]*?)<\/bullet>$/,
  );
  if (bulletMatch) return formatListItem("bullet", "-", bulletMatch[1], bulletMatch[2]);

  // 自闭合 bullet：<bullet indent="1" />文本
  const bulletSelfMatch = line.match(/^<bullet\s+indent="(\d+)"\s*\/>(.*)$/);
  if (bulletSelfMatch) {
    return formatListItem("bullet", "-", bulletSelfMatch[1], bulletSelfMatch[2]);
  }

  const quoteMatch = line.match(/^<quote>([\s\S]*?)<\/quote>$/);
  if (quoteMatch) {
    return { type: "quote", text: `> ${convertInlineStyles(quoteMatch[1].trim())}` };
  }

  const textMatch = line.match(
    /^<text(?:\s+indent="(\d+)")?\s*>([\s\S]*?)<\/text>$/,
  );
  if (textMatch) {
    const indentStr = textMatch[1];
    const inner = textMatch[2];
    if (!inner.trim()) return { type: "blank", text: "" };
    if (indentStr === "NaN") return { type: "blank", text: "" };

    const heading = tryParseHeading(inner);
    if (heading) return heading;

    const indent = getIndentLevel(indentStr);
    const spaces = "  ".repeat(indent);
    return { type: "text", text: `${spaces}${convertInlineStyles(inner.trim())}` };
  }

  const alignMatch = line.match(
    /^<align\s+align="(center|left|right)">([\s\S]*?)<\/align>$/,
  );
  if (alignMatch) {
    return {
      type: "text",
      text: `<div align="${alignMatch[1]}">${convertInlineStyles(alignMatch[2].trim())}</div>`,
    };
  }

  if (/^☺\s/.test(line)) return null;

  // 无法识别：去掉未知标签后保留文本
  const cleaned = convertInlineStyles(line).replace(/<[^>]+>/g, "").trim();
  return cleaned ? { type: "text", text: cleaned } : null;
}

function stripTrailingTags(s: string): string {
  // 去除复选框文本尾部可能残留的 <0/> 等空标记
  return s.replace(/<0\/>/g, "");
}

function formatListItem(
  type: string,
  marker: string,
  indentStr: string | undefined,
  content: string,
): ParsedLine {
  const indent = getIndentLevel(indentStr);
  const text = convertInlineStyles(content.trim());
  const spaces = "  ".repeat(indent);
  return { type, text: `${spaces}${marker} ${text}` };
}

function tryParseHeading(content: string): ParsedLine | null {
  const trimmed = content.trim();
  for (const { prefix, matchRegex } of HEADING_TAGS) {
    const match = trimmed.match(matchRegex);
    if (match) {
      return { type: "heading", text: `${prefix} ${convertInlineStyles(match[1].trim())}` };
    }
  }
  return null;
}

function convertInlineStyles(text: string): string {
  if (!text) return "";
  text = text.replace(/<b>([\s\S]*?)<\/b>/g, "**$1**");
  text = text.replace(/<i>([\s\S]*?)<\/i>/g, "*$1*");
  text = text.replace(/<delete>([\s\S]*?)<\/delete>/g, "~~$1~~");
  text = text.replace(/<u>([\s\S]*?)<\/u>/g, "<u>$1</u>");
  text = text.replace(
    /<background\s+color="([^"]+)">([\s\S]*?)<\/background>/g,
    (_m, color: string, inner: string) => `<mark style="background:${bgrToRgb(color)}">${inner}</mark>`,
  );
  for (const { inlineRegex } of HEADING_TAGS) {
    text = text.replace(inlineRegex, "**$1**");
  }
  return decodeHtmlEntities(text);
}

function getIndentLevel(indentStr: string | undefined): number {
  const n = Number(indentStr || 0);
  if (Number.isNaN(n)) return 0;
  return Math.max(0, n - 1);
}

function replaceAttachments(
  content: string,
  files: NoteFile[],
  assetPrefix: string,
): string {
  for (const file of files) {
    const assetPath = `${assetPrefix}${file.name}`;
    const escapedId = escapeRegex(file.rawId);
    const imgMd = `![${file.name}](${assetPath})`;
    for (const { tag, format } of MEDIA_TAG_FORMATS) {
      const regex = new RegExp(
        `<${tag}\\s+[^>]*(?:id|fileid|data)="[^"]*${escapedId}[^"]*"[^>]*/>`,
        "g",
      );
      content = content.replace(regex, format(file.name, assetPath));
    }
    content = content.replace(new RegExp(`☺\\s*${escapedId}<[^>]*></>`, "g"), imgMd);
    content = content.replace(new RegExp(`☺\\s*${escapedId}(?!<)`, "g"), imgMd);
  }
  return content;
}

// ============ Markdown → XML ============

const INDENT_TAB = "\t";

/**
 * 将 Markdown 转换为小米笔记 XML 内容（用于创建/更新）。
 * @param markdown Markdown 文本
 * @param imageMap 可选：Markdown 图片 target → fileId 映射（本地上传后回填）
 */
export function markdownToXml(
  markdown: string,
  imageMap: Map<string, string> = new Map(),
): string {
  if (!markdown) return "";
  const out: string[] = [];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/g, "");

    // 图片：minote://image/{id} 或本地映射
    const imageMatch = line.match(/!\[[^\]]*\]\(([^)]+)\)/);
    if (imageMatch) {
      const fileId = resolveImageFileId(imageMatch[1], imageMap);
      if (fileId) {
        out.push(`<img fileid="${fileId}" imgshow="0" imgdes="" />`);
        continue;
      }
    }

    // 标题
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const tag = level === 1 ? "size" : level === 2 ? "mid-size" : "h3-size";
      out.push(`<text indent="1"><${tag}>${escapeXml(heading[2])}</${tag}></text>`);
      continue;
    }

    // 分割线
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      out.push("<hr />");
      continue;
    }

    // 引用
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      out.push(`<quote>${inlineMdToXml(quote[1])}</quote>`);
      continue;
    }

    // 复选框
    if (/^(\s*)- \[x\]\s+/i.test(line)) {
      const text = line.replace(/^(\s*)- \[x\]\s+/i, "");
      out.push(`<input type="checkbox" checked="true" />${inlineMdToXml(text)}`);
      continue;
    }
    if (/^(\s*)- \[ \]\s+/.test(line)) {
      const text = line.replace(/^(\s*)- \[ \]\s+/, "");
      out.push(`<input type="checkbox" checked="false" />${inlineMdToXml(text)}`);
      continue;
    }

    // 无序列表（支持一级缩进）
    const bullet = line.match(/^(\s*)[-*]\s+(.*)$/);
    if (bullet) {
      const indent = computeIndent(bullet[1]);
      out.push(`<bullet indent="${indent}" />${inlineMdToXml(bullet[2])}`);
      continue;
    }

    // 有序列表
    const order = line.match(/^(\s*)\d+\.\s+(.*)$/);
    if (order) {
      const indent = computeIndent(order[1]);
      out.push(`<order indent="${indent}">${inlineMdToXml(order[2])}</order>`);
      continue;
    }

    // 空行
    if (!line.trim()) {
      out.push(`<text indent="1"></text>`);
      continue;
    }

    // 普通文本
    const indent = line.startsWith(INDENT_TAB) ? 2 : 1;
    const normalized = line.replace(/^\t/, "");
    out.push(`<text indent="${indent}">${inlineMdToXml(normalized)}</text>`);
  }

  return out.join("\n");
}

/** 行内 Markdown → XML（加粗/斜体/删除线） */
function inlineMdToXml(text: string): string {
  let escaped = escapeXml(text);
  escaped = escaped.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  escaped = escaped.replace(/(?<!\*)\*(?!\*)([^*]+?)\*(?!\*)/g, "<i>$1</i>");
  escaped = escaped.replace(/~~(.+?)~~/g, "<delete>$1</delete>");
  return escaped;
}

function computeIndent(leading: string): number {
  if (!leading) return 1;
  // 每 2 空格或 1 tab 视为一级缩进，最多支持到 2 级
  const tabs = (leading.match(/\t/g) || []).length;
  const spaces = (leading.match(/ /g) || []).length;
  const level = tabs + Math.floor(spaces / 2);
  return Math.min(2, 1 + level);
}

function resolveImageFileId(
  target: string,
  imageMap: Map<string, string>,
): string | undefined {
  if (target.startsWith("minote://image/")) {
    return target.substring("minote://image/".length);
  }
  return imageMap.get(target);
}

/** 从 XML 内容提取首行非空文本作为 snippet */
export function extractSnippet(xml: string): string {
  return (
    xml
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? ""
  );
}

/**
 * 按显示宽度截断字符串（CJK 字符记 2 列宽，其余记 1 列），超出加省略号。
 * 同时把内部换行/连续空白压成单空格，保证终端列表每条只占一行。
 * @param maxWidth 最大显示列宽
 */
export function truncateDisplay(text: string, maxWidth: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  let width = 0;
  let out = "";
  for (const ch of flat) {
    const w = isWide(ch) ? 2 : 1;
    if (width + w > maxWidth) {
      return out + "…";
    }
    width += w;
    out += ch;
  }
  return out;
}

/** 判断字符是否为宽字符（CJK、全角等占 2 列） */
function isWide(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK 部首、标点
    (cp >= 0x3041 && cp <= 0x33ff) || // 假名、CJK 符号
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK 扩展 A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 统一表意
    (cp >= 0xa000 && cp <= 0xa4cf) || // 彝文
    (cp >= 0xac00 && cp <= 0xd7a3) || // 谚文音节
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容表意
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK 兼容形式
    (cp >= 0xff00 && cp <= 0xff60) || // 全角 ASCII
    (cp >= 0xffe0 && cp <= 0xffe6) || // 全角符号
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK 扩展 B+及表情等
  );
}

// ============ 文件路径 ============

export function getNoteFilePath(
  note: ParsedNote,
  folders: Record<string, RawFolderEntry>,
  outputDir: string,
): string {
  const folder = note.folderId ? folders[note.folderId] : undefined;
  const folderName = folder ? sanitizeFileName(folder.subject || "") : "";
  const fileName = `${note.subject}.md`;
  return folderName
    ? join(outputDir, folderName, fileName)
    : join(outputDir, fileName);
}

// ============ 工具 ============

function bgrToRgb(bgrColor: string): string {
  if (!bgrColor || bgrColor.length < 6) return bgrColor;
  const hex = bgrColor.replace("#", "");
  const b = hex.slice(0, 2);
  const g = hex.slice(2, 4);
  const r = hex.slice(4, 6);
  return `#${r}${g}${b}`;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const HTML_ENTITY_MAP: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeHtmlEntities(value: string): string {
  return value.replace(/&([a-z]+);/gi, (_m, entity: string) => {
    const decoded = HTML_ENTITY_MAP[entity.toLowerCase()];
    return decoded ?? `&${entity};`;
  });
}
