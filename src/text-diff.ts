/** 行级 diff（LCS），用于同步冲突时对比两侧内容 */

export interface DiffLine {
  op: " " | "-" | "+";
  text: string;
}

/** 超过该规模（行数乘积）时不做 LCS，退化为整体替换，避免内存与耗时失控 */
const MAX_CELLS = 4_000_000;

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;
  if (n * m > MAX_CELLS) {
    return [
      ...a.map((text) => ({ op: "-" as const, text })),
      ...b.map((text) => ({ op: "+" as const, text })),
    ];
  }

  // lcs[i][j] = a[i..] 与 b[j..] 的最长公共子序列长度
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] =
        a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: " ", text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ op: "-", text: a[i++] });
    } else {
      out.push({ op: "+", text: b[j++] });
    }
  }
  while (i < n) out.push({ op: "-", text: a[i++] });
  while (j < m) out.push({ op: "+", text: b[j++] });
  return out;
}

/** 渲染为带 -/+ 前缀的文本；未改动的长段只保留前后 context 行 */
export function formatDiff(lines: DiffLine[], context = 3): string {
  const changed = lines.map((l) => l.op !== " ");
  const keep = lines.map((_, idx) => {
    for (let k = Math.max(0, idx - context); k <= Math.min(lines.length - 1, idx + context); k++) {
      if (changed[k]) return true;
    }
    return false;
  });

  const out: string[] = [];
  let skipped = 0;
  lines.forEach((l, idx) => {
    if (!keep[idx]) {
      skipped++;
      return;
    }
    if (skipped > 0) {
      out.push(`  … 省略 ${skipped} 行未改动内容`);
      skipped = 0;
    }
    out.push(`${l.op} ${l.text}`);
  });
  if (skipped > 0) out.push(`  … 省略 ${skipped} 行未改动内容`);
  return out.join("\n");
}
