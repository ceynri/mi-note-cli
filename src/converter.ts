import { join } from "node:path";
import { formatDateTime, getDateTokens, sanitizeFileName } from "./utils.js";
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
  const raw = deriveRawTitle(note);
  if (raw) return raw;

  // legacy fallback：抽内容首行作为标题（用于无模板时的默认文件名）
  // 注意此分支**仅用于 `ParsedNote.subject` 的 legacy 默认路径**，不进入 `rawTitle`，
  // 因此模板 `${title}` 在无真标题时不会拿到内容首行——避免把正文一句话扔进文件名。
  const firstLine = xmlToMarkdown(note.snippet ?? note.content ?? "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (firstLine) return firstLine;

  return formatDateTime(note.createDate || Date.now());
}

/**
 * 派生「真标题」：仅取 `extraInfo.title` 或 `RawNoteEntry.subject` 这两个**显式标题字段**，
 * 都为空则返回空字符串。
 *
 * 与 `deriveTitle` 的区别：**不**回退到「内容首行」——内容首行属于正文，把它当标题贴进
 * 文件名模板会让 `${title}` 拿到一句话甚至一长串文字，违背「title 表示用户为笔记起的名字」
 * 这一直觉。文件名模板专用，由调用方决定空值时如何兜底（智能裁分隔符 / datetime 等）。
 */
export function deriveRawTitle(note: RawNoteEntry): string {
  const extra = parseExtraInfo(note.extraInfo);
  const extraTitle = (extra.title as string)?.trim();
  if (extraTitle) return extraTitle;
  if (note.subject?.trim()) return note.subject.trim();
  return "";
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
  const rawTitle = deriveRawTitle(note);
  const files = parseNoteFiles(note);

  return {
    id,
    folderId,
    subject,
    rawTitle,
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

  // 多行 <quote>...</quote>：把内部换行用占位符替换，让整个 quote 合并成单行 token
  // 交给 parseLine 解析时再还原。这样可以复用逐行解析的主循环。
  text = text.replace(/<quote>([\s\S]*?)<\/quote>/g, (_m, inner: string) =>
    `<quote>${inner.replace(/\n/g, "\u2028")}</quote>`,
  );

  const lines = text.split("\n");
  const mdLines: string[] = [];
  let prevType = "";

  // 按 indent 分组的运行计数器：解析 inputNumber=0 时的真实序号。
  // 任何非 order 行（或无法识别行）都会清空，与 Mi Note 客户端「order 链被打断即重置」的语义对齐。
  const orderCounters = new Map<number, number>();

  for (const line of lines) {
    const parsed = parseLine(line.trim(), orderCounters);
    if (parsed === null) {
      orderCounters.clear();
      continue;
    }
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

function parseLine(
  line: string,
  orderCounters?: Map<number, number>,
): ParsedLine | null {
  if (!line) {
    orderCounters?.clear();
    return { type: "blank", text: "" };
  }

  // order：小米客户端原生形态 `<order indent="N" inputNumber="X" />文本`
  // - inputNumber>0：显式数字，刷新该层运行计数器为该值（后续 inputNumber=0 接续 +1）
  // - inputNumber=0 或缺省：取该层运行计数 +1（首次出现即 1）
  // - 进入更浅层时，所有更深 indent 的计数器作废
  // 此分支必须放在「清空计数器」之前——它是唯一会读写计数器的分支。
  const orderSelfMatch = line.match(
    /^<order\s+indent="(\d+)"(?:\s+inputNumber="(\d+)")?\s*\/>(.*)$/,
  );
  if (orderSelfMatch) {
    const indent = getIndentLevel(orderSelfMatch[1]);
    const numberRaw = orderSelfMatch[2];
    const explicit = numberRaw ? Number(numberRaw) : 0;
    let number: number;
    if (orderCounters) {
      for (const k of [...orderCounters.keys()]) {
        if (k > indent) orderCounters.delete(k);
      }
      number =
        explicit > 0 ? explicit : (orderCounters.get(indent) ?? 0) + 1;
      orderCounters.set(indent, number);
    } else {
      number = explicit > 0 ? explicit : 1;
    }
    return formatListItem("order", `${number}.`, orderSelfMatch[1], orderSelfMatch[3]);
  }

  // 其余分支均视为 order 链被打断（含 hr / 复选框 / bullet / quote / 普通文本 / 标题等）
  orderCounters?.clear();

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
    // 把 xmlToMarkdown 预处理时塞入的 \u2028 占位符还原为换行
    const inner = quoteMatch[1].replace(/\u2028/g, "\n");
    // 内部可能是小米客户端的多行形态：<text indent="1">行</text>\n<text>...</text>
    // 也可能是旧的简单形态：直接 inline 文本
    const innerTexts = [...inner.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)].map(
      (m) => m[1].trim(),
    );
    const quoteLines = innerTexts.length > 0 ? innerTexts : [inner.trim()];
    const text = quoteLines
      .map((l) => `> ${convertInlineStyles(l)}`)
      .join("\n");
    return { type: "quote", text };
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

  // 多行 quote：把连续的 `> ` 行合并成单个 <quote><text>...</text>...</quote>
  // 直接在主循环之外预处理，避免逐行匹配丢失上下文
  type Block =
    | { kind: "raw"; line: string }
    | { kind: "quote"; lines: string[] };
  const blocks: Block[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^>\s?(.*)$/);
    if (m) {
      const quoteLines: string[] = [m[1]];
      while (i + 1 < lines.length) {
        const m2 = lines[i + 1].match(/^>\s?(.*)$/);
        if (!m2) break;
        quoteLines.push(m2[1]);
        i++;
      }
      blocks.push({ kind: "quote", lines: quoteLines });
    } else {
      blocks.push({ kind: "raw", line: lines[i] });
    }
  }

  // 列表层级推断（栈式相对缩进）
  // 维护一个 { width, level } 栈：遇到比栈顶宽的缩进进入下一级；相等保持；更窄则弹栈。
  // 这样能容忍 2/3/4 空格混用、tab 缩进，无需做 CommonMark 完整解析。
  const indentStack: { width: number; level: number }[] = [];
  const widthOfLeading = (leading: string): number => {
    let w = 0;
    for (const c of leading) {
      if (c === "\t") w += 4;
      else if (c === " ") w += 1;
      else break;
    }
    return w;
  };
  const determineListLevel = (leading: string): number => {
    const width = widthOfLeading(leading);
    while (indentStack.length > 0 && indentStack[indentStack.length - 1].width > width) {
      indentStack.pop();
    }
    if (indentStack.length > 0 && indentStack[indentStack.length - 1].width === width) {
      return indentStack[indentStack.length - 1].level;
    }
    const newLevel = indentStack.length === 0 ? 1 : indentStack[indentStack.length - 1].level + 1;
    indentStack.push({ width, level: newLevel });
    return newLevel;
  };
  const resetListStack = () => {
    indentStack.length = 0;
  };

  for (const block of blocks) {
    if (block.kind === "quote") {
      // 多行 quote：每行作为一个内部 <text indent="1">；
      // 单行 quote 也用同一格式，便于反向解析统一处理。
      const inner = block.lines
        .map((l) => `<text indent="1">${inlineMdToXml(l)}</text>`)
        .join("\n");
      out.push(`<quote>${inner}</quote>`);
      resetListStack();
      continue;
    }

    const rawLine = block.line;
    const line = rawLine.replace(/\s+$/g, "");

    // 图片：minote://image/{id} 或本地映射
    const imageMatch = line.match(/!\[[^\]]*\]\(([^)]+)\)/);
    if (imageMatch) {
      const fileId = resolveImageFileId(imageMatch[1], imageMap);
      if (fileId) {
        out.push(`<img fileid="${fileId}" imgshow="0" imgdes="" />`);
        resetListStack();
        continue;
      }
    }

    // 标题
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const tag = level === 1 ? "size" : level === 2 ? "mid-size" : "h3-size";
      out.push(`<text indent="1"><${tag}>${escapeXml(heading[2])}</${tag}></text>`);
      resetListStack();
      continue;
    }

    // 分割线
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      out.push("<hr />");
      resetListStack();
      continue;
    }

    // 复选框（小米原生形态：indent="N" level="3"，level 含义未明但小米客户端固定写 3）
    const checkbox = line.match(/^(\s*)- \[([xX ])\]\s+(.*)$/);
    if (checkbox) {
      const indent = determineListLevel(checkbox[1]);
      const checked = checkbox[2].toLowerCase() === "x";
      const checkedAttr = checked ? ' checked="true"' : "";
      out.push(
        `<input type="checkbox" indent="${indent}" level="3"${checkedAttr} />${inlineMdToXml(checkbox[3])}`,
      );
      continue;
    }

    // 无序列表
    const bullet = line.match(/^(\s*)[-*]\s+(.*)$/);
    if (bullet) {
      const indent = determineListLevel(bullet[1]);
      out.push(`<bullet indent="${indent}" />${inlineMdToXml(bullet[2])}`);
      continue;
    }

    // 有序列表
    // 小米客户端原生形态：`<order indent="N" inputNumber="X" />文本`
    // - 必须自闭合 + 后置文本（与 bullet 一致；闭合包裹形式 `<order>...</order>` 会被吞内容）
    // - 必须显式带 inputNumber，按用户写的数字渲染；否则被 <text> 段落打断后，相邻自增计数会重置
    const order = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
    if (order) {
      const indent = determineListLevel(order[1]);
      const number = order[2];
      out.push(
        `<order indent="${indent}" inputNumber="${number}" />${inlineMdToXml(order[3])}`,
      );
      continue;
    }

    // 空行：保留 <text indent="1"></text> 占位；列表栈不变（允许列表中间夹空行）
    if (!line.trim()) {
      out.push(`<text indent="1"></text>`);
      continue;
    }

    // 普通文本：会终止上一段列表的层级关系
    const indent = line.startsWith(INDENT_TAB) ? 2 : 1;
    const normalized = line.replace(/^\t/, "");
    out.push(`<text indent="${indent}">${inlineMdToXml(normalized)}</text>`);
    resetListStack();
  }

  return out.join("\n");
}

/**
 * 行内 Markdown → XML（加粗/斜体/删除线/下划线）。
 * 下划线在 markdown 中以 HTML 形式 `<u>...</u>` 书写——是 markdown 允许的内联 HTML。
 */
function inlineMdToXml(text: string): string {
  // 抽出 <u>...</u> 内容到占位符，避免被 escapeXml 转义；最后把内容（仍需 escape）放回 <u> 标签
  const uPlaceholders: string[] = [];
  const PH_OPEN = "\uE000U";
  const PH_CLOSE = "\uE001";
  let stage = text.replace(/<u>([\s\S]*?)<\/u>/g, (_m, inner: string) => {
    const idx = uPlaceholders.length;
    uPlaceholders.push(inner);
    return `${PH_OPEN}${idx}${PH_CLOSE}`;
  });
  stage = escapeXml(stage);
  stage = stage.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  stage = stage.replace(/(?<!\*)\*(?!\*)([^*]+?)\*(?!\*)/g, "<i>$1</i>");
  stage = stage.replace(/~~(.+?)~~/g, "<delete>$1</delete>");
  // 占位符还原成 <u>...</u>，内容仍需 escape（防 < & 等字符）
  stage = stage.replace(
    new RegExp(`${PH_OPEN}(\\d+)${PH_CLOSE}`, "g"),
    (_m, idx: string) => `<u>${escapeXml(uPlaceholders[+idx])}</u>`,
  );
  return stage;
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

/**
 * 计算笔记落盘路径（含目录：云端 folder → 一级子目录）。
 *
 * - `template` 缺省：文件名直接用 `note.subject`（已含 datetime fallback，向后兼容）
 * - `template` 非空：按模板渲染（占位符替换 + 智能裁分隔符 + sanitize），
 *   渲染后为空时回退到创建时间字符串，避免产出空文件名
 */
export function getNoteFilePath(
  note: ParsedNote,
  folders: Record<string, RawFolderEntry>,
  outputDir: string,
  template?: string,
): string {
  const folder = note.folderId ? folders[note.folderId] : undefined;
  const folderName = folder ? sanitizeFileName(folder.subject || "") : "";
  const baseName =
    template && template.trim() ? renderFileNameTemplate(template, note) : note.subject;
  const fileName = `${baseName}.md`;
  return folderName
    ? join(outputDir, folderName, fileName)
    : join(outputDir, fileName);
}

/**
 * 渲染文件名模板。
 *
 * 占位符（字面替换）：
 * - `${YYYY}` `${YY}` `${MM}` `${DD}` `${HH}` `${mm}` `${ss}`：基于 `createDate` 的本地时区分量
 *   （`YYYY`=4 位年，`YY`=2 位年，其余两位零填充）
 * - `${title}`：真实标题，用户没填即空字符串
 * - `${subject}`：带兜底的笔记称呼（标题 → 内容首行 → datetime），永远非空
 * - `${id}`：笔记 id
 * - 未识别的 `${xxx}` 原样保留
 *
 * 条件段语法 `[...]`：
 *   方括号内的内容只有当所有 `${var}` 都非空时才渲染，否则**整块丢弃**——
 *   主要用法是把可选段连同其引导分隔符一起包起来，避免空 title 导致多余分隔符。
 *   - 例：`${YYYY}-${MM}-${DD}[_${title}]` → 有标题 `2026-06-06_工作`，无标题 `2026-06-06`
 *   - 不支持嵌套；未匹配的 `[` 当字面保留
 *   - 字面 `[` `]` 用 `\[` `\]` 转义
 *
 * 后处理：
 * 1. 经 `sanitizeFileName` 清理 OS 非法字符
 * 2. 若结果为空（如模板仅有 `${title}` 且无标题），回退到 datetime 防止产出空文件名
 *
 * 不做首尾/连续分隔符的隐式处理——所见即所得，可选段请用 `[...]` 显式表达。
 */
export function renderFileNameTemplate(template: string, note: ParsedNote): string {
  const ts = note.createDate || Date.now();
  const t = getDateTokens(ts);
  const vars: Record<string, string> = {
    YYYY: t.YYYY,
    YY: t.YY,
    MM: t.MM,
    DD: t.DD,
    HH: t.HH,
    mm: t.mm,
    ss: t.ss,
    title: note.rawTitle,
    subject: note.subject,
    id: note.id,
  };

  // 用 NUL/SOH 哨兵临时替换 `\[` `\]` 转义，避免被条件段解析器误吞。
  // 这两个控制字符在文件名里非法，不会与用户输入冲突。
  const ESC_OPEN = "\u0000";
  const ESC_CLOSE = "\u0001";
  let s = template.replace(/\\\[/g, ESC_OPEN).replace(/\\\]/g, ESC_CLOSE);

  // 条件段：`[...]` 内任一 `${var}` 为空 → 整块丢；全非空 → 正常渲染。
  // flat 不支持嵌套；未匹配的 `[` 不会被这里命中，自然作为字面留到下一步。
  s = s.replace(/\[([^\[\]]*)\]/g, (_, segment: string) => {
    let allFilled = true;
    const rendered = segment.replace(/\$\{(\w+)\}/g, (m, key: string) => {
      if (!Object.prototype.hasOwnProperty.call(vars, key)) return m;
      const v = vars[key];
      if (!v) allFilled = false;
      return v;
    });
    return allFilled ? rendered : "";
  });

  // 段外剩余 `${var}`
  s = s.replace(/\$\{(\w+)\}/g, (m, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : m,
  );

  // 还原转义的字面 `[` `]`
  s = s.replace(new RegExp(ESC_OPEN, "g"), "[").replace(new RegExp(ESC_CLOSE, "g"), "]");

  const cleaned = sanitizeFileName(s);
  if (cleaned) return cleaned;

  // 兜底：模板渲染为空时（如纯 `${title}` 无标题）退回 datetime，绝不产出空文件名
  return formatDateTime(ts);
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
