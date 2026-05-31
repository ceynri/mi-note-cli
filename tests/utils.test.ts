import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeFileName,
  formatDateTime,
  getCacheDir,
  inferImageMimeType,
} from "../src/utils.ts";
import { extractCookieValue } from "../src/auth.ts";
import { buildExtraInfoString } from "../src/note.ts";

test("sanitizeFileName: 替换非法字符", () => {
  assert.equal(sanitizeFileName('a/b\\c:d*e?f"g<h>i|j'), "a_b_c_d_e_f_g_h_i_j");
});

test("sanitizeFileName: 去除首尾点和空白", () => {
  assert.equal(sanitizeFileName("  ..名字..  "), "名字");
});

test("sanitizeFileName: 截断超长名", () => {
  const long = "a".repeat(300);
  assert.equal(sanitizeFileName(long).length, 200);
});

test("formatDateTime: 格式正确", () => {
  const s = formatDateTime(new Date(2025, 0, 2, 3, 4, 5).getTime());
  assert.equal(s, "2025-01-02_03-04-05");
});

test("getCacheDir: 含应用名", () => {
  assert.ok(getCacheDir().includes("mi-note-cli"));
});

test("inferImageMimeType: 常见类型", () => {
  assert.equal(inferImageMimeType("a.png"), "image/png");
  assert.equal(inferImageMimeType("a.JPG"), "image/jpeg");
  assert.equal(inferImageMimeType("a.gif"), "image/gif");
  assert.equal(inferImageMimeType("a.webp"), "image/webp");
  assert.equal(inferImageMimeType("a.unknown"), "application/octet-stream");
});

test("extractCookieValue: 提取字段", () => {
  const cookie = "userId=123; serviceToken=abc; i.mi.com_slh=xyz";
  assert.equal(extractCookieValue(cookie, "serviceToken"), "abc");
  assert.equal(extractCookieValue(cookie, "userId"), "123");
});

test("extractCookieValue: 缺失非必需字段返回空", () => {
  assert.equal(extractCookieValue("a=1", "missing", false), "");
});

test("extractCookieValue: 缺失必需字段抛错", () => {
  assert.throws(() => extractCookieValue("a=1", "serviceToken"));
});

test("buildExtraInfoString: 含标题", () => {
  const s = buildExtraInfoString("我的标题");
  const parsed = JSON.parse(s!);
  assert.equal(parsed.title, "我的标题");
  assert.equal(parsed.note_content_type, "common");
});

test("buildExtraInfoString: 保留已有字段", () => {
  const existing = JSON.stringify({
    title: "旧标题",
    note_content_type: "common",
    mind_content: "xxx",
  });
  const s = buildExtraInfoString("新标题", existing);
  const parsed = JSON.parse(s!);
  assert.equal(parsed.title, "新标题");
  assert.equal(parsed.mind_content, "xxx");
});

test("buildExtraInfoString: 无标题且无已有信息时仅含默认类型", () => {
  const s = buildExtraInfoString(undefined);
  const parsed = JSON.parse(s!);
  assert.equal(parsed.note_content_type, "common");
  assert.equal(parsed.title, undefined);
});
