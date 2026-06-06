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
  // checkbox 输出对齐小米客户端原生形态：indent + level=3，未勾选省略 checked 属性
  assert.equal(
    markdownToXml("- [x] 完成"),
    '<input type="checkbox" indent="1" level="3" checked="true" />完成',
  );
  assert.equal(
    markdownToXml("- [ ] 待办"),
    '<input type="checkbox" indent="1" level="3" />待办',
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

// ============ 多行 quote ============

test("markdownToXml: 多行 quote 合并为一个 <quote>", () => {
  // 连续多行 `> ...` 合并为单个 <quote>，内部用 <text> 表达每行
  const md = "> 第一行\n> 第二行\n> 第三行";
  const xml = markdownToXml(md);
  assert.equal(
    xml,
    `<quote><text indent="1">第一行</text>\n<text indent="1">第二行</text>\n<text indent="1">第三行</text></quote>`,
  );
});

test("xmlToMarkdown: 多行 quote 反向解析", () => {
  const xml = `<quote><text indent="1">第一行</text>\n<text indent="1">第二行</text></quote>`;
  assert.equal(xmlToMarkdown(xml), "> 第一行\n> 第二行");
});

test("xmlToMarkdown: 单行 quote（旧形态）仍兼容", () => {
  // 旧版 CLI 输出 <quote>inline</quote> 形态也能被解析
  assert.equal(xmlToMarkdown("<quote>引用文本</quote>"), "> 引用文本");
});

// ============ 下划线 <u> ============

test("markdownToXml: 下划线 <u>...</u> 保留为 XML 同名标签", () => {
  assert.equal(
    markdownToXml("文字<u>下划</u>结束"),
    '<text indent="1">文字<u>下划</u>结束</text>',
  );
});

test("xmlToMarkdown: 下划线 <u> 反向解析", () => {
  assert.equal(xmlToMarkdown('<text indent="1">文字<u>下划</u>结束</text>'), "文字<u>下划</u>结束");
});

test("inline 富文本：<u> 内含特殊字符正确转义", () => {
  // 用户写 `<u>a < b</u>` 时，内部 `<` 仍要被 escape，避免破坏 XML
  const xml = markdownToXml("<u>a < b</u>");
  assert.equal(xml, '<text indent="1"><u>a &lt; b</u></text>');
});

// ============ checkbox 多级 + 原生属性 ============

test("markdownToXml: checkbox 输出对齐小米客户端原生形态（带 indent + level=3）", () => {
  assert.equal(
    markdownToXml("- [ ] 待办"),
    '<input type="checkbox" indent="1" level="3" />待办',
  );
  assert.equal(
    markdownToXml("- [x] 完成"),
    '<input type="checkbox" indent="1" level="3" checked="true" />完成',
  );
});

test("markdownToXml: 多级 checkbox（按相对缩进推断 indent）", () => {
  const md = ["- [ ] 顶级", "  - [x] 二级", "    - [ ] 三级"].join("\n");
  const xml = markdownToXml(md);
  assert.ok(xml.includes('indent="1" level="3"'));
  assert.ok(xml.includes('indent="2" level="3"'));
  assert.ok(xml.includes('indent="3" level="3"'));
});

// ============ 缩进推断（栈式相对算法） ============

test("markdownToXml: 列表缩进按栈式相对算法推断（兼容 2/3/4 空格）", () => {
  // 同一级缩进可以是 2 / 3 / 4 空格——只要相对父项更宽就算下一级
  // 这里第一级用 3 空格（format 工具常见对齐风格）
  const md = ["1. 顶级", "   1. 二级", "      1. 三级"].join("\n");
  const xml = markdownToXml(md);
  assert.ok(xml.includes('<order indent="1" inputNumber="1" />顶级'));
  assert.ok(xml.includes('<order indent="2" inputNumber="1" />二级'));
  assert.ok(xml.includes('<order indent="3" inputNumber="1" />三级'));
});

test("markdownToXml: 缩进栈在普通段落后重置", () => {
  // 第一段嵌套 1→2→1，普通段落穿插重置后，再次 1→2 应能从顶层重新计算
  const md = ["1. A", "  - a 子", "段落", "1. B", "  - b 子"].join("\n");
  const xml = markdownToXml(md);
  // 两组都应能正确推断为顶级 + 二级
  const orders = (xml.match(/<order [^/]*\/>/g) || []);
  const bullets = (xml.match(/<bullet [^/]*\/>/g) || []);
  assert.equal(orders.length, 2);
  assert.equal(bullets.length, 2);
  assert.ok(orders.every((o) => o.includes('indent="1"')));
  assert.ok(bullets.every((b) => b.includes('indent="2"')));
});

test("markdownToXml: 引用与分割线", () => {
  // 单行 quote 也用小米客户端原生的多行形态（内部 <text> 节点）
  assert.equal(
    markdownToXml("> 引用"),
    '<quote><text indent="1">引用</text></quote>',
  );
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

// ============ 端到端：与小米客户端原生 XML 互通 ============

test("端到端：小米客户端原生 XML（含多级 order/bullet、checkbox、富文本、quote）能反向解析", () => {
  // 直接复刻一份小米客户端导出的真实笔记 XML（来自「测试0606」笔记）
  const xml = [
    '<new-format/><order indent="1" inputNumber="1" />第一段',
    '<text indent="1">然后我说了一些中间的话</text>',
    '<order indent="1" inputNumber="2" />然后是第二段',
    '<text indent="1">这里继续续着前面的序号是没问题的</text>',
    '<order indent="1" inputNumber="3" />一级第三段',
    '<order indent="2" inputNumber="0" />二级',
    '<order indent="2" inputNumber="0" />二级第二段',
    '<order indent="3" inputNumber="0" />三级',
    '<order indent="4" inputNumber="0" />四级',
    '<order indent="3" inputNumber="0" />三级第三段',
    '<text indent="1"></text>',
    '<input type="checkbox" indent="1" level="3" />未完成项',
    '<input type="checkbox" indent="1" level="3" checked="true" />完成项',
    '<text indent="1"></text>',
    '<text indent="1"><size>一级标题</size></text>',
    '<text indent="1"><mid-size>二级标题</mid-size></text>',
    '<text indent="1"><h3-size>三级标题</h3-size></text>',
    '<text indent="1">文字<b>加粗</b></text>',
    '<text indent="1">文字<i>斜体</i></text>',
    '<text indent="1">文字<u>下划线</u></text>',
    '<text indent="1">文字<delete>删除线</delete></text>',
    '<bullet indent="1" />无序列表1',
    '<bullet indent="2" />无序列表缩进',
    '<bullet indent="3" />无序列表二级缩进',
    '<text indent="1"></text>',
    '<quote><text indent="1">引用内容</text>',
    '<text indent="1">引用内容第二行</text></quote>',
  ].join("\n");
  const md = xmlToMarkdown(xml);
  // 关键内容都在
  assert.ok(md.includes("1. 第一段"));
  assert.ok(md.includes("2. 然后是第二段"));
  assert.ok(md.includes("3. 一级第三段"));
  assert.ok(md.includes("  1. 二级")); // indent=2 → 2 空格
  assert.ok(md.includes("    1. 三级")); // indent=3 → 4 空格
  assert.ok(md.includes("      1. 四级")); // indent=4 → 6 空格
  assert.ok(md.includes("- [ ] 未完成项"));
  assert.ok(md.includes("- [x] 完成项"));
  assert.ok(md.includes("# 一级标题"));
  assert.ok(md.includes("## 二级标题"));
  assert.ok(md.includes("### 三级标题"));
  assert.ok(md.includes("文字**加粗**"));
  assert.ok(md.includes("文字*斜体*"));
  assert.ok(md.includes("文字<u>下划线</u>"));
  assert.ok(md.includes("文字~~删除线~~"));
  assert.ok(md.includes("- 无序列表1"));
  assert.ok(md.includes("  - 无序列表缩进"));
  assert.ok(md.includes("    - 无序列表二级缩进"));
  assert.ok(md.includes("> 引用内容"));
  assert.ok(md.includes("> 引用内容第二行"));
});

test("端到端：markdown 多种格式能转出小米客户端可识别的 XML", () => {
  const md = [
    "# 一级标题",
    "## 二级标题",
    "",
    "1. 第一段",
    "",
    "中间段落",
    "",
    "2. 第二段",
    "  1. 子项 a",
    "  2. 子项 b",
    "",
    "- [ ] 待办",
    "- [x] 已办",
    "",
    "文字**粗** *斜* ~~删~~ <u>下</u>",
    "",
    "> 引用 1",
    "> 引用 2",
  ].join("\n");
  const xml = markdownToXml(md);
  // 关键节点都用了原生形态
  assert.ok(xml.includes("<size>一级标题</size>"));
  assert.ok(xml.includes("<mid-size>二级标题</mid-size>"));
  assert.ok(xml.includes('<order indent="1" inputNumber="1" />第一段'));
  assert.ok(xml.includes('<order indent="1" inputNumber="2" />第二段'));
  assert.ok(xml.includes('<order indent="2" inputNumber="1" />子项 a'));
  assert.ok(xml.includes('<order indent="2" inputNumber="2" />子项 b'));
  assert.ok(xml.includes('<input type="checkbox" indent="1" level="3" />待办'));
  assert.ok(
    xml.includes('<input type="checkbox" indent="1" level="3" checked="true" />已办'),
  );
  assert.ok(xml.includes("<b>粗</b>"));
  assert.ok(xml.includes("<i>斜</i>"));
  assert.ok(xml.includes("<delete>删</delete>"));
  assert.ok(xml.includes("<u>下</u>"));
  assert.ok(
    xml.includes('<quote><text indent="1">引用 1</text>\n<text indent="1">引用 2</text></quote>'),
  );
});

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
