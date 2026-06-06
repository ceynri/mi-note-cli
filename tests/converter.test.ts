import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  xmlToMarkdown,
  markdownToXml,
  deriveTitle,
  parseNoteEntry,
  extractSnippet,
  truncateDisplay,
  renderFileNameTemplate,
} from "../src/converter.ts";
import type { RawNoteEntry, ParsedNote } from "../src/types.ts";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

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
  // 含 inputNumber>0 时按显式数字渲染；缺省 / inputNumber=0 时按同层运行计数自增。
  const xml =
    `<order indent="1" inputNumber="2" />显式二\n<order indent="1" />缺省接续\n<bullet indent="1" />无序项`;
  assert.equal(xmlToMarkdown(xml), "2. 显式二\n3. 缺省接续\n- 无序项");
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
  // inputNumber=0 时按「同 indent 运行计数器 +1」自增；进入更浅层时深层计数器作废。
  // 缩进按 2 空格/级
  const md = xmlToMarkdown(xml);
  assert.ok(md.includes("1. 一级 A"));
  assert.ok(md.includes("  1. 二级 a"));
  assert.ok(md.includes("  2. 二级 b"));
  assert.ok(md.includes("    1. 三级"));
  assert.ok(md.includes("2. 一级 B"));
});

test("xmlToMarkdown: order 自动续号被深浅层切换（回归 #order-autonumber）", () => {
  // 复刻「测试0606」笔记的真实形态：含显式 inputNumber + 多级嵌套 + 跨层回弹。
  // 期望：显式数字保留，inputNumber=0 沿用同层运行计数，跨层回弹时深层计数器作废。
  const xml = [
    '<order indent="1" inputNumber="3" />一级第三段',
    '<order indent="2" inputNumber="0" />二级',
    '<order indent="2" inputNumber="0" />二级第二段',
    '<order indent="2" inputNumber="0" />二级第三段',
    '<order indent="3" inputNumber="0" />三级',
    '<order indent="3" inputNumber="0" />三级第二段',
    '<order indent="4" inputNumber="0" />四级',
    '<order indent="4" inputNumber="0" />四级第二段',
    '<order indent="3" inputNumber="0" />三级第三段',
    '<order indent="1" inputNumber="0" />一级第四段',
  ].join("\n");
  assert.equal(
    xmlToMarkdown(xml),
    [
      "3. 一级第三段",
      "  1. 二级",
      "  2. 二级第二段",
      "  3. 二级第三段",
      "    1. 三级",
      "    2. 三级第二段",
      "      1. 四级",
      "      2. 四级第二段",
      "    3. 三级第三段",
      "4. 一级第四段",
    ].join("\n"),
  );
});

test("xmlToMarkdown: order 链被普通文本打断后重新从 1 开始", () => {
  // Mi Note 客户端语义：任何非 order 内容（含空段落 <text indent="1"></text>）都会重置自动续号。
  const xml = [
    '<order indent="1" inputNumber="0" />A',
    '<text indent="1">中间段落</text>',
    '<order indent="1" inputNumber="0" />B',
    '<text indent="1"></text>',
    '<order indent="1" inputNumber="0" />C',
  ].join("\n");
  const md = xmlToMarkdown(xml);
  // A、B、C 都是各自链条的首项，都应输出 1.
  assert.ok(md.includes("1. A"));
  assert.ok(md.includes("1. B"));
  assert.ok(md.includes("1. C"));
});

test("xmlToMarkdown: 显式 inputNumber 后接 inputNumber=0 时基于显式值续号", () => {
  // 用户在客户端写「5.」（显式 5）后回车继续输入（自动续号 6）
  const xml = [
    '<order indent="1" inputNumber="5" />A',
    '<order indent="1" inputNumber="0" />B',
    '<order indent="1" inputNumber="0" />C',
  ].join("\n");
  const md = xmlToMarkdown(xml);
  assert.ok(md.includes("5. A"));
  assert.ok(md.includes("6. B"));
  assert.ok(md.includes("7. C"));
});

test("xmlToMarkdown: order 被段落打断后用显式数字续上文（不重置回 1）", () => {
  // 场景：1.A 2.B → 中间 <text> 段落打断 → 用户写 3.C 4.D 想接续上文
  // 关键语义：段落打断会清空运行计数器，但下一个 order 若带显式 inputNumber 就以该值刷新计数器；
  //          同链后续 inputNumber=0 在显式值基础上继续 +1（覆盖「重新从 1 开始」分支）
  const xml = [
    '<order indent="1" inputNumber="1" />A',
    '<order indent="1" inputNumber="2" />B',
    '<text indent="1">中间段落</text>',
    '<order indent="1" inputNumber="3" />C',
    '<order indent="1" inputNumber="0" />D',
  ].join("\n");
  const md = xmlToMarkdown(xml);
  assert.ok(md.includes("1. A"));
  assert.ok(md.includes("2. B"));
  assert.ok(md.includes("3. C"));
  // 显式 3 刷新计数器，inputNumber=0 应得 4（而非被 <text> 重置后的 1）
  assert.ok(md.includes("4. D"), `应得 4. D，实际：${md}`);
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

// ============================================================
// 文件名模板渲染
// ============================================================

/**
 * 构造一个最小可用的 ParsedNote，仅模板渲染会读到的字段。
 *
 * - `rawTitle`：真实标题（默认空，表示用户没起标题）
 * - `subject`：带兜底的称呼（默认随 rawTitle 而定，无 rawTitle 时给一个占位字符串
 *   模拟 deriveTitle 的内容首行/datetime 兜底；显式传入则覆盖）
 */
function makeNote(opts: {
  rawTitle?: string;
  subject?: string;
  id?: string;
  createDate?: number;
} = {}): ParsedNote {
  const rawTitle = opts.rawTitle ?? "";
  return {
    id: opts.id ?? "n123",
    folderId: "",
    subject: opts.subject ?? (rawTitle || "fallback-subject"),
    rawTitle,
    content: "",
    files: [],
    createDate: opts.createDate,
    modifyDate: undefined,
    contentType: "note",
  };
}

// 用一个固定时间戳，避免依赖时区（我们只断言「占位符被替换」而非具体值，
// 但不同分量的零填充行为需要稳定可断言，因此用本地构造的时间）
const FIXED = new Date(2026, 5, 6, 14, 3, 0).getTime(); // 2026-06-06 14:03:00 本地

test("renderFileNameTemplate: 仅 ${title}，有标题", () => {
  const r = renderFileNameTemplate("${title}", makeNote({ rawTitle: "读书笔记", createDate: FIXED }));
  assert.equal(r, "读书笔记");
});

test("renderFileNameTemplate: 仅 ${title}，无标题回退到 datetime", () => {
  const r = renderFileNameTemplate("${title}", makeNote({ rawTitle: "", createDate: FIXED }));
  assert.equal(r, "2026-06-06_14-03-00");
});

test("renderFileNameTemplate: ${subject} 永有兜底（即使无真实标题）", () => {
  // 用户没起标题时，${title} = ""，${subject} = 内容首行/datetime（这里模拟为 fallback-subject）
  const r = renderFileNameTemplate(
    "${subject}",
    makeNote({ rawTitle: "", subject: "内容首行截断", createDate: FIXED }),
  );
  assert.equal(r, "内容首行截断");
});

test("renderFileNameTemplate: ${title} vs ${subject} 同模板对比", () => {
  // 同一笔记：rawTitle="" subject="内容首行兜底"
  const note = makeNote({ rawTitle: "", subject: "内容首行兜底", createDate: FIXED });
  // ${title} 走严格语义 → 空 → 触发 datetime 兜底（仅 ${title} 时整体渲染为空）
  assert.equal(renderFileNameTemplate("${title}", note), "2026-06-06_14-03-00");
  // ${subject} 走兜底语义 → 用首行
  assert.equal(
    renderFileNameTemplate("${YYYY}-${MM}-${DD}-${subject}", note),
    "2026-06-06-内容首行兜底",
  );
});

test("renderFileNameTemplate: ${YY} 取年份后两位", () => {
  const r = renderFileNameTemplate(
    "${YY}-${MM}-${DD}",
    makeNote({ createDate: FIXED }),
  );
  assert.equal(r, "26-06-06");
});

test("renderFileNameTemplate: 字面字符照原样保留（不做 trim/collapse）", () => {
  // 中间字面分隔符
  assert.equal(
    renderFileNameTemplate("${YYYY}_${MM}_${DD}_笔记", makeNote({ createDate: FIXED })),
    "2026_06_06_笔记",
  );
  // 中间双下划线
  assert.equal(
    renderFileNameTemplate("${YYYY}__${MM}", makeNote({ createDate: FIXED })),
    "2026__06",
  );
  // 尾部字面分隔符也保留（用户写什么就是什么；空 title 用 [...] 显式处理）
  assert.equal(
    renderFileNameTemplate("${YYYY}_笔记_", makeNote({ createDate: FIXED })),
    "2026_笔记_",
  );
});

// ============ [...] 条件段 ============

test("renderFileNameTemplate: [...] 内 ${title} 非空时整段渲染", () => {
  const r = renderFileNameTemplate(
    "${YYYY}-${MM}-${DD}[_${title}]",
    makeNote({ rawTitle: "读书笔记", createDate: FIXED }),
  );
  assert.equal(r, "2026-06-06_读书笔记");
});

test("renderFileNameTemplate: [...] 内 ${title} 为空时整段消失", () => {
  const r = renderFileNameTemplate(
    "${YYYY}-${MM}-${DD}[_${title}]",
    makeNote({ rawTitle: "", createDate: FIXED }),
  );
  assert.equal(r, "2026-06-06");
});

test("renderFileNameTemplate: [...] 块内多个 ${var} 任一为空则整块丢", () => {
  // [${title}-${id}]：title 空 → 整块（含 id）一起丢
  const note = makeNote({ rawTitle: "", id: "42", createDate: FIXED });
  assert.equal(
    renderFileNameTemplate("${YYYY}[-${title}-${id}]", note),
    "2026",
  );
  // 同模板，title 非空 → 整块渲染
  const note2 = makeNote({ rawTitle: "甲", id: "42", createDate: FIXED });
  assert.equal(
    renderFileNameTemplate("${YYYY}[-${title}-${id}]", note2),
    "2026-甲-42",
  );
});

test("renderFileNameTemplate: 多个 [...] 段相互独立", () => {
  const note = makeNote({ rawTitle: "标题", id: "42", createDate: FIXED });
  // 两段都渲染
  assert.equal(
    renderFileNameTemplate("[${title}][_${id}]", note),
    "标题_42",
  );
  // 第一段消失、第二段保留
  const note2 = makeNote({ rawTitle: "", id: "42", createDate: FIXED });
  assert.equal(
    renderFileNameTemplate("${YYYY}[_${title}][_${id}]", note2),
    "2026_42",
  );
});

test("renderFileNameTemplate: \\[ \\] 转义产出字面方括号", () => {
  const r = renderFileNameTemplate(
    "\\[${YYYY}\\]_${title}",
    makeNote({ rawTitle: "标题", createDate: FIXED }),
  );
  assert.equal(r, "[2026]_标题");
});

test("renderFileNameTemplate: 未配对的 [ 当作字面保留", () => {
  // 单独的 `[` 不会被条件段 regex 匹配，自然作为字面留下
  const r = renderFileNameTemplate(
    "${YYYY}[unclosed",
    makeNote({ createDate: FIXED }),
  );
  assert.equal(r, "2026[unclosed");
});

// ============ 其他占位符 ============

test("renderFileNameTemplate: ${id} 占位符", () => {
  const r = renderFileNameTemplate("${id}-${title}", makeNote({ id: "42", rawTitle: "x", createDate: FIXED }));
  assert.equal(r, "42-x");
});

test("renderFileNameTemplate: 未识别占位符原样保留", () => {
  const r = renderFileNameTemplate("${unknown}-${title}", makeNote({ rawTitle: "标题", createDate: FIXED }));
  assert.equal(r, "${unknown}-标题");
});

// ============================================================
// 文件级 round-trip：md → xml → md 字节相等（夹具守恒）
// ============================================================

test("round-trip: 综合夹具 md → xml → md 严格相等（trim 后）", () => {
  const md = readFileSync(join(FIXTURES_DIR, "round-trip.md"), "utf-8");
  const xml = markdownToXml(md);
  const back = xmlToMarkdown(xml);
  // xmlToMarkdown 末尾 trim() 会去掉文件末尾换行，原文也 trim 后比对
  assert.equal(back.trim(), md.trim());
});
