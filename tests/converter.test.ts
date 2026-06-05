import { test } from "node:test";
import assert from "node:assert/strict";
import {
  xmlToMarkdown,
  markdownToXml,
  deriveTitle,
  parseNoteEntry,
  extractSnippet,
  truncateDisplay,
} from "../src/converter.ts";
import type { RawNoteEntry } from "../src/types.ts";

test("truncateDisplay: 短文本不截断", () => {
  assert.equal(truncateDisplay("短标题", 60), "短标题");
});

test("truncateDisplay: 中文按双宽截断加省略号", () => {
  const r = truncateDisplay("讲".repeat(100), 60);
  assert.equal(r, "讲".repeat(30) + "…"); // 60 列 / 2 = 30 字
});

test("truncateDisplay: 英文按单宽截断", () => {
  const r = truncateDisplay("a".repeat(100), 60);
  assert.equal(r, "a".repeat(60) + "…");
});

test("truncateDisplay: 换行与连续空白压成单空格", () => {
  assert.equal(truncateDisplay("第一行\n\n第二行  第三", 60), "第一行 第二行 第三");
});

// ============ XML → Markdown ============

test("xmlToMarkdown: 标题", () => {
  assert.equal(xmlToMarkdown("<text><size>大标题</size></text>"), "# 大标题");
  assert.equal(xmlToMarkdown("<text><mid-size>二级</mid-size></text>"), "## 二级");
  assert.equal(xmlToMarkdown("<text><h3-size>三级</h3-size></text>"), "### 三级");
});

test("xmlToMarkdown: 无序/有序列表", () => {
  const xml = `<bullet indent="1">项一</bullet>\n<bullet indent="1">项二</bullet>`;
  assert.equal(xmlToMarkdown(xml), "- 项一\n- 项二");
  // 小米客户端原生 order 形态带 inputNumber，按显式数字解析回 markdown
  const ordered =
    `<order indent="1" inputNumber="1" />第一\n<order indent="1" inputNumber="2" />第二`;
  assert.equal(xmlToMarkdown(ordered), "1. 第一\n2. 第二");
});

test("xmlToMarkdown: 自闭合 order/bullet（小米客户端真实形态）", () => {
  // 含 inputNumber 时按显式数字渲染；缺省时回退为 1（向后兼容）
  const xml =
    `<order indent="1" inputNumber="2" />显式二\n<order indent="1" />缺省一\n<bullet indent="1" />无序项`;
  assert.equal(xmlToMarkdown(xml), "2. 显式二\n1. 缺省一\n- 无序项");
});

test("xmlToMarkdown: 复选框", () => {
  assert.equal(
    xmlToMarkdown('<input type="checkbox" checked="true" />已完成'),
    "- [x] 已完成",
  );
  assert.equal(
    xmlToMarkdown('<input type="checkbox" checked="false" />待办'),
    "- [ ] 待办",
  );
});

test("xmlToMarkdown: 引用与分割线", () => {
  assert.equal(xmlToMarkdown("<quote>引用文本</quote>"), "> 引用文本");
  assert.equal(xmlToMarkdown("<hr />"), "---");
});

test("xmlToMarkdown: 行内样式", () => {
  assert.equal(xmlToMarkdown("<text><b>粗</b></text>"), "**粗**");
  assert.equal(xmlToMarkdown("<text><i>斜</i></text>"), "*斜*");
  assert.equal(xmlToMarkdown("<text><delete>删</delete></text>"), "~~删~~");
});

test("xmlToMarkdown: HTML 实体解码", () => {
  assert.equal(xmlToMarkdown("<text>a &amp; b &lt; c</text>"), "a & b < c");
});

// ============ Markdown → XML ============

test("markdownToXml: 标题", () => {
  assert.equal(markdownToXml("# 标题"), '<text indent="1"><size>标题</size></text>');
  assert.equal(
    markdownToXml("## 二级"),
    '<text indent="1"><mid-size>二级</mid-size></text>',
  );
});

test("markdownToXml: 列表与复选框", () => {
  assert.equal(markdownToXml("- 项目"), '<bullet indent="1" />项目');
  // 有序列表带显式 inputNumber，按用户写的数字渲染（避免被小米客户端按相邻自增重置）
  assert.equal(
    markdownToXml("1. 项目"),
    '<order indent="1" inputNumber="1" />项目',
  );
  assert.equal(
    markdownToXml("- [x] 完成"),
    '<input type="checkbox" checked="true" />完成',
  );
  assert.equal(
    markdownToXml("- [ ] 待办"),
    '<input type="checkbox" checked="false" />待办',
  );
});

test("markdownToXml: 有序列表保留用户原数字（回归 #order-renumber）", () => {
  // 小米 <order> 在没有 inputNumber 时按相邻自增计数，被 <text> 段落打断会重置回 1。
  // 必须给每项显式标 inputNumber，让客户端按指定数字渲染。
  const md = "1. 第一项\n2. 第二项\n3. 第三项";
  assert.equal(
    markdownToXml(md),
    '<order indent="1" inputNumber="1" />第一项\n<order indent="1" inputNumber="2" />第二项\n<order indent="1" inputNumber="3" />第三项',
  );
});

test("markdownToXml: 被段落打断的有序项 inputNumber 也保留原数字", () => {
  // 用户写 `1. ... <段落> ... 2. ...` 中间被打断，2. 必须仍渲染为 2.
  const md = "1. 标题甲\n\n说明甲\n\n2. 标题乙\n\n说明乙";
  const xml = markdownToXml(md);
  assert.ok(xml.includes('<order indent="1" inputNumber="1" />标题甲'));
  assert.ok(xml.includes('<order indent="1" inputNumber="2" />标题乙'));
});

test("markdownToXml: 多级有序/无序列表（按缩进推算 indent）", () => {
  // 约定：每 2 空格 / 1 tab 为一级缩进，不再封顶到 2 级。
  const md = [
    "1. 一级",
    "  1. 二级 a",
    "  2. 二级 b",
    "    1. 三级",
    "      1. 四级",
    "- 无序一级",
    "  - 无序二级",
    "    - 无序三级",
  ].join("\n");
  const xml = markdownToXml(md);
  assert.ok(xml.includes('<order indent="1" inputNumber="1" />一级'));
  assert.ok(xml.includes('<order indent="2" inputNumber="1" />二级 a'));
  assert.ok(xml.includes('<order indent="2" inputNumber="2" />二级 b'));
  assert.ok(xml.includes('<order indent="3" inputNumber="1" />三级'));
  assert.ok(xml.includes('<order indent="4" inputNumber="1" />四级'));
  assert.ok(xml.includes('<bullet indent="1" />无序一级'));
  assert.ok(xml.includes('<bullet indent="2" />无序二级'));
  assert.ok(xml.includes('<bullet indent="3" />无序三级'));
});

test("xmlToMarkdown: 多级列表反向解析（小米客户端真实形态）", () => {
  // 复刻小米客户端写出的多级 order 形态
  const xml = [
    '<order indent="1" inputNumber="1" />一级 A',
    '<order indent="2" inputNumber="0" />二级 a',
    '<order indent="2" inputNumber="0" />二级 b',
    '<order indent="3" inputNumber="0" />三级',
    '<order indent="1" inputNumber="0" />一级 B',
  ].join("\n");
  // inputNumber=0 时回退为 1（客户端自身按相邻规则计数；导出时只能取静态值）
  // 缩进按 2 空格/级
  const md = xmlToMarkdown(xml);
  assert.ok(md.includes("1. 一级 A"));
  assert.ok(md.includes("  1. 二级 a"));
  assert.ok(md.includes("  1. 二级 b"));
  assert.ok(md.includes("    1. 三级"));
  assert.ok(md.includes("1. 一级 B"));
});

test("markdownToXml: 引用与分割线", () => {
  assert.equal(markdownToXml("> 引用"), "<quote>引用</quote>");
  assert.equal(markdownToXml("---"), "<hr />");
});

test("markdownToXml: 普通文本与加粗", () => {
  assert.equal(markdownToXml("普通"), '<text indent="1">普通</text>');
  assert.equal(
    markdownToXml("含**粗体**字"),
    '<text indent="1">含<b>粗体</b>字</text>',
  );
});

test("markdownToXml: XML 特殊字符转义", () => {
  assert.equal(
    markdownToXml("a < b & c"),
    '<text indent="1">a &lt; b &amp; c</text>',
  );
});

test("markdownToXml: 图片 minote 协议", () => {
  assert.equal(
    markdownToXml("![图](minote://image/abc123)"),
    '<img fileid="abc123" imgshow="0" imgdes="" />',
  );
});

// ============ 往返一致性 ============

test("往返：Markdown → XML → Markdown 保持语义", () => {
  const md = "# 标题\n\n正文一行\n\n- 列表项\n- 第二项\n\n> 引用";
  const xml = markdownToXml(md);
  const back = xmlToMarkdown(xml);
  assert.ok(back.includes("# 标题"));
  assert.ok(back.includes("正文一行"));
  assert.ok(back.includes("- 列表项"));
  assert.ok(back.includes("- 第二项"));
  assert.ok(back.includes("> 引用"));
});

// ============ 标题派生 / 解析 ============

test("deriveTitle: extraInfo.title 优先", () => {
  const note: RawNoteEntry = {
    id: "1",
    extraInfo: JSON.stringify({ title: "我的标题" }),
    subject: "subject 标题",
  };
  assert.equal(deriveTitle(note), "我的标题");
});

test("deriveTitle: 回退到 subject", () => {
  const note: RawNoteEntry = { id: "1", subject: "subject 标题" };
  assert.equal(deriveTitle(note), "subject 标题");
});

test("deriveTitle: 回退到内容首行", () => {
  const note: RawNoteEntry = {
    id: "1",
    content: "<text>第一行内容</text>",
  };
  assert.equal(deriveTitle(note), "第一行内容");
});

test("parseNoteEntry: 规范化字段", () => {
  const note: RawNoteEntry = {
    id: 123,
    folderId: 456,
    content: "<text>内容</text>",
    extraInfo: JSON.stringify({ title: "标题" }),
    createDate: 1000,
    modifyDate: 2000,
  };
  const parsed = parseNoteEntry(note);
  assert.equal(parsed.id, "123");
  assert.equal(parsed.folderId, "456");
  assert.equal(parsed.subject, "标题");
  assert.equal(parsed.modifyDate, 2000);
});

test("extractSnippet: 取首个非空行", () => {
  assert.equal(extractSnippet("\n\n<text>第一</text>\n<text>第二</text>"), "<text>第一</text>");
  assert.equal(extractSnippet(""), "");
});
