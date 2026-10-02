import { test } from "node:test";
import assert from "node:assert/strict";
import { diffLines, formatDiff } from "../src/text-diff.ts";

test("diffLines: 相同内容全为上下文行", () => {
  assert.deepEqual(diffLines("a\nb", "a\nb"), [
    { op: " ", text: "a" },
    { op: " ", text: "b" },
  ]);
});

test("diffLines: 标出增删行", () => {
  assert.deepEqual(diffLines("a\nb\nc", "a\nx\nc"), [
    { op: " ", text: "a" },
    { op: "-", text: "b" },
    { op: "+", text: "x" },
    { op: " ", text: "c" },
  ]);
});

test("formatDiff: 折叠远离改动的未变行", () => {
  const before = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n");
  const after = before.replace("l10", "changed");
  const out = formatDiff(diffLines(before, after), 1);
  assert.equal(
    out,
    ["  … 省略 9 行未改动内容", "  l9", "- l10", "+ changed", "  l11", "  … 省略 8 行未改动内容"].join("\n"),
  );
});
