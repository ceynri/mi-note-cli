import { readFile, writeFile, rm, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, sep, resolve as resolvePath } from "node:path";
import type { MiNoteClient } from "./client.js";
import {
  parseNoteEntry,
  xmlToMarkdown,
  markdownToXml,
  extractSnippet,
  getNoteFilePath,
  buildImageMap,
} from "./converter.js";
import { uploadLocalImages, withAttachments } from "./images.js";
import { buildExtraInfoString } from "./note.js";
import {
  randomDelay,
  ensureFileDir,
  fileExists,
  ensureDir,
  sanitizeFileName,
  getCacheDir,
} from "./utils.js";
import { logInfo } from "./output.js";
import {
  loadUserConfig,
  loadState,
  saveState,
  toOutputRel,
  toOutputAbs,
} from "./config.js";
import { classify, decide } from "./sync-diff.js";
import type {
  ParsedNote,
  RawNoteEntry,
  RawFolderEntry,
  SyncState,
  SyncNoteState,
  SyncMode,
  WriteNoteEntry,
} from "./types.js";
import type { Scenario, SyncAction } from "./sync-diff.js";

const SAVE_INTERVAL = 10;
const TOOL_VERSION = (
  createRequire(import.meta.url)("../package.json") as { version: string }
).version;

/** export / sync 实际用到的客户端能力（便于测试注入假实现） */
export type SyncClient = Pick<
  MiNoteClient,
  | "getAllNotes"
  | "getNote"
  | "createNote"
  | "updateNote"
  | "deleteNote"
  | "createFolder"
  | "downloadFile"
  | "uploadImage"
>;

export function computeHash(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

// ============================================================
// 落盘路径：同名笔记去重
// ============================================================

/** 路径比较键：macOS / Windows 默认文件系统大小写不敏感 */
function pathKey(p: string): string {
  const abs = resolvePath(p);
  return process.platform === "darwin" || process.platform === "win32"
    ? abs.toLowerCase()
    : abs;
}

/**
 * 笔记文件里附件引用的前缀：附件统一存放在 `<output>/assets/`，
 * 子目录（云端文件夹）里的笔记需要 `../assets/` 才能被 Markdown 查看器正确解析。
 */
export function assetPrefixFor(filePath: string, outputDir: string): string {
  const rel = relative(dirname(filePath), join(outputDir, "assets"));
  return `${rel.split(sep).join("/")}/`;
}

/** 下载笔记附件到 `<output>/assets/`（已存在的跳过），返回下载失败的文件名 */
async function downloadAttachments(
  client: SyncClient,
  files: ParsedNote["files"],
  outputDir: string,
): Promise<string[]> {
  const failed: string[] = [];
  for (const f of files) {
    if (!(await client.downloadFile(f.fileId, join(outputDir, "assets", f.name)))) {
      failed.push(f.name);
    }
  }
  return failed;
}

function attachmentError(failed: string[]): string {
  return `附件下载失败：${failed.join("、")}（正文已写入）`;
}

/** 同名冲突时的备用路径：`<name>_<id>.md`（id 唯一，结果稳定） */
export function withIdSuffix(filePath: string, id: string): string {
  const base = filePath.endsWith(".md") ? filePath.slice(0, -3) : filePath;
  return `${base}_${id}.md`;
}

/**
 * 为一批笔记分配互不冲突的落盘路径（export 用，无状态故需确定性）：
 * 同一路径下创建最早的笔记保留原名，其余加 id 后缀。
 */
export function assignUniquePaths(
  items: { id: string; createDate?: number; desired: string }[],
): Map<string, string> {
  const groups = new Map<string, typeof items>();
  for (const it of items) {
    const key = pathKey(it.desired);
    const group = groups.get(key);
    if (group) group.push(it);
    else groups.set(key, [it]);
  }
  const result = new Map<string, string>();
  for (const group of groups.values()) {
    group.sort(
      (a, b) =>
        (a.createDate ?? 0) - (b.createDate ?? 0) || a.id.localeCompare(b.id),
    );
    group.forEach((it, i) => {
      result.set(it.id, i === 0 ? it.desired : withIdSuffix(it.desired, it.id));
    });
  }
  return result;
}

// ============================================================
// export：纯单向 云→本地 快照。永不修改云端，不依赖/不写同步状态。
// ============================================================

export interface ExportError {
  id: string;
  error: string;
}

export interface ExportResult {
  total: number;
  written: number;
  skipped: number;
  empty: number;
  failed: number;
  errors: ExportError[];
  outputDir: string;
}

/**
 * export 增量缓存（放在全局缓存目录，不写进导出目录）。只用来跳过「拉详情」，删掉即全量重来。
 * 某条笔记命中缓存需同时满足：云端 modifyDate 与所在文件夹（id + 名称）未变、
 * 上次写出的文件仍在且内容未被改动；工具版本或文件名模板变化时整份作废。
 */
interface ExportCacheEntry {
  modifyDate?: number;
  folderId: string;
  folderName: string;
  empty?: boolean;
  createDate?: number;
  /** 去重前的期望路径（相对 output），参与本次去重分配 */
  desired?: string;
  /** 实际写出的路径（相对 output） */
  filePath?: string;
  hash?: string;
}

interface ExportCache {
  version: string;
  template: string | null;
  notes: Record<string, ExportCacheEntry>;
}

/** 某个导出目录对应的增量缓存文件路径 */
export function getExportCachePath(outputDir: string): string {
  const key = createHash("sha1").update(resolvePath(outputDir)).digest("hex").slice(0, 16);
  return join(getCacheDir(), "export", `${key}.json`);
}

async function loadExportCache(
  cachePath: string,
  template: string | null,
): Promise<Record<string, ExportCacheEntry>> {
  try {
    const cache = JSON.parse(await readFile(cachePath, "utf-8")) as ExportCache;
    if (cache.version !== TOOL_VERSION || cache.template !== template) return {};
    return cache.notes ?? {};
  } catch {
    return {};
  }
}

/**
 * 导出全部笔记为本地 Markdown（单向、只读云端）。
 *
 * - 拉取云端全部笔记 → 转 Markdown → 写本地（按文件夹组织）
 * - 下载附件到 assets/
 * - 增量：云端未变且本地文件未被改动的笔记直接跳过（见 ExportCacheEntry）；force=true 时全量重来
 * - 同名笔记不互相覆盖：创建最早的保留原名，其余加 `_<id>` 后缀
 * - 不删除任何云端笔记；不因本地缺失而回写云端
 */
export async function exportNotes(
  client: SyncClient,
  outputDir: string,
  force = false,
  quiet = false,
  cachePath = getExportCachePath(outputDir),
): Promise<ExportResult> {
  const log = (msg: string): void => {
    if (!quiet) logInfo(msg);
  };

  log("📂 开始导出...");
  const template = (await loadUserConfig()).fileNameTemplate ?? null;

  const { entries, folders } = await client.getAllNotes(200, (count) => {
    if (!quiet) process.stderr.write(`\r📋 已获取 ${count} 条笔记...`);
  });
  if (!quiet) process.stderr.write(`\r📋 共获取 ${entries.length} 条笔记\n`);

  await ensureDir(outputDir);
  await ensureDir(join(outputDir, "assets"));

  const cache = force ? {} : await loadExportCache(cachePath, template);
  const nextCache: Record<string, ExportCacheEntry> = {};
  const rel = (p: string): string => toOutputRel(p, outputDir);
  const abs = (p: string): string => toOutputAbs(p, outputDir);

  let written = 0;
  let skipped = 0;
  let emptyCount = 0;
  const errors: ExportError[] = [];
  const recordError = (id: string, err: unknown): void => {
    const message = (err as Error).message;
    errors.push({ id, error: message });
    if (!quiet) process.stderr.write(`\n❌ 导出失败 [${id}]: ${message}\n`);
  };

  // 先拉齐全部详情再分配路径：同名去重需要看到整批笔记才能确定性地决定谁保留原名
  const fresh: { note: ParsedNote; markdown: string; key: ExportCacheEntry }[] = [];
  const cached: { id: string; entry: ExportCacheEntry }[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const id = String(entry.id);
    if (!quiet) {
      const pct = (((i + 1) / entries.length) * 100).toFixed(1);
      process.stderr.write(`\r⏳ 导出中... ${i + 1}/${entries.length} (${pct}%)`);
    }
    const folderId = String(entry.folderId ?? "0");
    const key: ExportCacheEntry = {
      modifyDate: entry.modifyDate,
      folderId,
      folderName: folders[folderId]?.subject ?? "",
    };
    try {
      const hit = cache[id];
      if (
        hit &&
        hit.modifyDate === key.modifyDate &&
        hit.folderId === key.folderId &&
        hit.folderName === key.folderName
      ) {
        if (hit.empty) {
          emptyCount++;
          nextCache[id] = hit;
          continue;
        }
        const file = hit.filePath ? abs(hit.filePath) : undefined;
        if (
          file &&
          hit.desired &&
          (await fileExists(file)) &&
          computeHash(await readFile(file, "utf-8")) === hit.hash
        ) {
          cached.push({ id, entry: hit });
          continue;
        }
      }

      const note = parseNoteEntry(await client.getNote(id));
      await randomDelay(300);
      const desired = getNoteFilePath(note, folders, outputDir, template ?? undefined);
      const markdown = xmlToMarkdown(note.content, note.files, assetPrefixFor(desired, outputDir));
      if (!markdown.trim()) {
        emptyCount++;
        nextCache[id] = { ...key, empty: true };
        continue;
      }
      fresh.push({ note, markdown, key: { ...key, createDate: note.createDate, desired: rel(desired) } });
    } catch (err) {
      recordError(id, err);
    }
  }

  const paths = assignUniquePaths([
    ...fresh.map(({ note, key }) => ({ id: note.id, createDate: key.createDate, desired: abs(key.desired!) })),
    ...cached.map(({ id, entry }) => ({ id, createDate: entry.createDate, desired: abs(entry.desired!) })),
  ]);

  // 命中缓存的笔记：内容已确认与上次写出的一致，仅在去重结果变化时挪到新路径
  for (const { id, entry } of cached) {
    try {
      const target = paths.get(id)!;
      const file = abs(entry.filePath!);
      if (pathKey(target) === pathKey(file)) {
        skipped++;
      } else {
        // 去重分配结果变了（同名笔记集合变化）：挪到新路径。
        // 旧文件内容与缓存校验过的哈希一致、是我们上次写出的产物，可安全删除，
        // 留在原地反而会被后续 sync 当成「本地新增」重复上传。
        await ensureFileDir(target);
        await writeFile(target, await readFile(file, "utf-8"), "utf-8");
        await rm(file, { force: true });
        written++;
      }
      nextCache[id] = { ...entry, filePath: rel(target) };
    } catch (err) {
      recordError(id, err);
    }
  }

  for (const { note, markdown, key } of fresh) {
    try {
      const filePath = paths.get(note.id)!;
      const unchanged =
        !force &&
        (await fileExists(filePath)) &&
        computeHash(await readFile(filePath, "utf-8")) === computeHash(markdown);
      if (unchanged) {
        skipped++;
      } else {
        await ensureFileDir(filePath);
        await writeFile(filePath, markdown, "utf-8");
        written++;
      }
      // 正文未变也补齐附件：上次下载失败的借此重试（已存在的文件不会重复下载）。
      // 有失败则不写入缓存，下次导出会重新检查这条笔记。
      const failedFiles = await downloadAttachments(client, note.files, outputDir);
      if (failedFiles.length > 0) throw new Error(attachmentError(failedFiles));
      nextCache[note.id] = { ...key, filePath: rel(filePath), hash: computeHash(markdown) };
    } catch (err) {
      recordError(note.id, err);
    }
  }

  const nextFile: ExportCache = { version: TOOL_VERSION, template, notes: nextCache };
  await ensureFileDir(cachePath);
  await writeFile(cachePath, JSON.stringify(nextFile), "utf-8");

  if (!quiet) {
    process.stderr.write("\n");
    log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 导出完成
  总笔记数: ${entries.length}
  写入:     ${written}
  未修改:   ${skipped}
  空笔记:   ${emptyCount}
  失败:     ${errors.length}
  输出目录: ${outputDir}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  }

  return {
    total: entries.length,
    written,
    skipped,
    empty: emptyCount,
    failed: errors.length,
    errors,
    outputDir,
  };
}

// ============================================================
// sync：双向同步。3-way diff + mode 决策。
// ============================================================

/** 一条待处理项的解析结果 */
export interface SyncPlanItem {
  id: string;
  subject: string;
  scenario: Scenario;
  action: SyncAction;
  /** 云端原始 entry（若存在） */
  remote?: RawNoteEntry;
  /** 本地文件路径（若存在或将写入） */
  filePath: string | null;
  /** 本地当前 markdown（若本地存在） */
  localMarkdown?: string;
  /** 云端当前 markdown（若云端存在） */
  remoteMarkdown?: string;
}

export interface SyncError {
  id: string;
  subject: string;
  action: SyncAction;
  error: string;
}

export interface SyncResult {
  total: number;
  applied: Record<SyncAction, number>;
  conflicts: SyncPlanItem[];
  errors: SyncError[];
  outputDir: string;
  mode: SyncMode;
  dryRun: boolean;
}

/** 冲突询问回调：返回针对该冲突要采取的具体动作（或 skip） */
export type ConflictResolver = (
  item: SyncPlanItem,
) => Promise<SyncAction>;

/**
 * 构建同步计划：对每条笔记做 3-way diff 并按 mode 决策动作。
 * 不触碰云端与本地文件；只在内存中修正 state（认领、去重），由调用方决定是否落盘。
 *
 * @returns stateChanged 为 true 时即使 plan 为空也应保存 state
 */
export async function buildSyncPlan(
  client: SyncClient,
  outputDir: string,
  mode: SyncMode,
  quiet = false,
): Promise<{
  plan: SyncPlanItem[];
  state: SyncState;
  folders: Record<string, RawFolderEntry>;
  stateChanged: boolean;
}> {
  const state = await loadState(outputDir);
  const fileNameTemplate = (await loadUserConfig()).fileNameTemplate;
  let stateChanged = await dedupeStatePaths(state, outputDir);

  const { entries, folders } = await client.getAllNotes(200, (count) => {
    if (!quiet) process.stderr.write(`\r📋 已获取 ${count} 条笔记...`);
  });
  if (!quiet) process.stderr.write("\r");

  const remoteById = new Map<string, RawNoteEntry>();
  for (const e of entries) remoteById.set(String(e.id), e);

  // 已被某条笔记占用的本地路径：state 记录的 + 本次认领的
  const trackedPaths = new Set<string>();
  for (const n of Object.values(state.notes)) {
    if (n.filePath) trackedPaths.add(pathKey(toOutputAbs(n.filePath, outputDir)));
  }

  // 收集所有涉及的 id：云端的 ∪ 状态里记录过的
  const allIds = new Set<string>([
    ...remoteById.keys(),
    ...Object.keys(state.notes),
  ]);

  const plan: SyncPlanItem[] = [];

  for (const id of allIds) {
    const remote = remoteById.get(id);
    const base = state.notes[id];

    // 先读本地（不依赖网络）。state 里 filePath 为相对 output 的相对路径，读写时转绝对。
    let localMarkdown: string | undefined;
    let localHash: string | undefined;
    let filePath = base?.filePath ? toOutputAbs(base.filePath, outputDir) : null;
    if (filePath && (await fileExists(filePath))) {
      localMarkdown = await readFile(filePath, "utf-8");
      localHash = computeHash(localMarkdown);
    }

    // 效率优化：云端 modifyDate 未变 且 本地哈希未变 → 必然 in-sync，跳过拉详情
    const remoteUnchanged =
      remote !== undefined &&
      base?.remoteModify !== undefined &&
      remote.modifyDate === base.remoteModify;
    const localUnchanged = localHash !== undefined && localHash === base?.localHash;
    if (remoteUnchanged && localUnchanged) {
      continue; // in-sync，无需动作
    }

    // 计算 remote markdown / hash（仅在可能变化时拉详情）
    let remoteMarkdown: string | undefined;
    let remoteHash: string | undefined;
    let remoteDetail: RawNoteEntry | undefined;
    let remoteNote: ParsedNote | undefined;
    let desired: string | undefined;
    if (remote) {
      remoteDetail = await client.getNote(id);
      remoteNote = parseNoteEntry(remoteDetail);
      desired = getNoteFilePath(remoteNote, folders, outputDir, fileNameTemplate);
      remoteMarkdown = xmlToMarkdown(
        remoteNote.content,
        remoteNote.files,
        assetPrefixFor(desired, outputDir),
      );
      remoteHash = computeHash(remoteMarkdown);
    }

    // 旧版本在子目录笔记里把附件写成 `assets/`（正确应为 `../assets/`）。
    // 本地内容若只差这个前缀，不能当成云端改动，否则会误报冲突。
    const legacyHash = (): string | undefined =>
      remoteNote && desired && assetPrefixFor(desired, outputDir) !== "assets/"
        ? computeHash(xmlToMarkdown(remoteNote.content, remoteNote.files, "assets/"))
        : undefined;

    // 认领：尚无基线的云端笔记，若其落盘位置已有未被跟踪的本地文件（如先 export 过），
    // 视为同一笔记参与 3-way 比较，而不是把它当成「本地新增」再上传一份重复笔记。
    let baseHash = base?.baseHash;
    if (!base && remoteNote && desired) {
      const key = pathKey(desired);
      if (!trackedPaths.has(key) && (await fileExists(desired))) {
        trackedPaths.add(key);
        filePath = desired;
        localMarkdown = await readFile(desired, "utf-8");
        localHash = computeHash(localMarkdown);
        // 与云端只差旧前缀：以本地为基线，按「仅云端变化」刷新文件
        if (localHash !== remoteHash && legacyHash() === localHash) {
          baseHash = localHash;
        }
      }
    }

    let scenario = classify({ baseHash, remoteHash, localHash });
    if (scenario === "both-changed" && baseHash && legacyHash() === baseHash) {
      scenario = "local-changed"; // 云端内容其实没变，只是引用前缀换了写法
    }
    const action = decide(scenario, mode);

    if (scenario === "in-sync") {
      if (!base && remoteDetail && remoteNote && filePath && remoteHash) {
        state.notes[id] = {
          id,
          subject: remoteNote.subject,
          filePath: toOutputRel(filePath, outputDir),
          folderId: remoteNote.folderId,
          baseHash: remoteHash,
          localHash: remoteHash,
          remoteModify: remoteDetail.modifyDate,
        };
        stateChanged = true;
      }
      continue;
    }

    plan.push({
      id,
      subject: remoteNote?.subject || base?.subject || id,
      scenario,
      action,
      remote: remoteDetail ?? remote,
      filePath,
      localMarkdown,
      remoteMarkdown,
    });
  }

  // 检测「本地新增文件」(#6)：输出目录下未被状态记录、也未被认领的 .md 文件。
  const localFiles = await scanMarkdownFiles(outputDir);
  for (const fp of localFiles) {
    if (trackedPaths.has(pathKey(fp))) continue;
    const localMarkdown = await readFile(fp, "utf-8");
    if (!localMarkdown.trim()) continue; // 空文件忽略
    // 无 base、无 remote、有 local → classify 为 local-new
    const scenario = classify({ localHash: computeHash(localMarkdown) });
    const action = decide(scenario, mode);
    // 用文件路径作为计划项的临时标识（尚无云端 id）
    plan.push({
      id: `local:${fp}`,
      subject: titleFromPath(fp, `local:${fp}`),
      scenario,
      action,
      filePath: fp,
      localMarkdown,
    });
  }

  return { plan, state, folders, stateChanged };
}

/**
 * 修复多条笔记记录指向同一本地文件的状态（旧版本同名笔记互相覆盖所致）：
 * 仅保留基线与文件当前内容一致的那条，其余移出状态，按云端新增重新落盘（届时会加 id 后缀）。
 * 都对不上时全部移出，文件作为未跟踪文件参与认领/冲突判定，不擅自归属。
 */
async function dedupeStatePaths(
  state: SyncState,
  outputDir: string,
): Promise<boolean> {
  const groups = new Map<string, SyncNoteState[]>();
  for (const n of Object.values(state.notes)) {
    if (!n.filePath) continue;
    const key = pathKey(toOutputAbs(n.filePath, outputDir));
    const group = groups.get(key);
    if (group) group.push(n);
    else groups.set(key, [n]);
  }

  let changed = false;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const abs = toOutputAbs(group[0].filePath!, outputDir);
    const hash = (await fileExists(abs))
      ? computeHash(await readFile(abs, "utf-8"))
      : undefined;
    const owner = hash ? group.find((n) => n.baseHash === hash) : undefined;
    for (const n of group) {
      if (n !== owner) delete state.notes[n.id];
    }
    changed = true;
  }
  return changed;
}

/**
 * 执行同步计划。
 * @param resolveConflict 遇到 action==="conflict" 时调用；不提供则跳过并计入冲突列表
 */
export async function executeSyncPlan(
  client: SyncClient,
  outputDir: string,
  mode: SyncMode,
  plan: SyncPlanItem[],
  state: SyncState,
  folders: Record<string, RawFolderEntry>,
  opts: { dryRun?: boolean; quiet?: boolean; resolveConflict?: ConflictResolver } = {},
): Promise<SyncResult> {
  const { dryRun = false, quiet = false, resolveConflict } = opts;
  const fileNameTemplate = (await loadUserConfig()).fileNameTemplate;
  const applied: Record<SyncAction, number> = {
    skip: 0,
    "update-local": 0,
    "update-remote": 0,
    "create-local": 0,
    "create-remote": 0,
    "delete-local": 0,
    "delete-remote": 0,
    "drop-state": 0,
    conflict: 0,
  };
  const conflicts: SyncPlanItem[] = [];
  const errors: SyncError[] = [];

  let processed = 0;
  for (const item of plan) {
    let action = item.action;

    if (action === "conflict") {
      if (resolveConflict) {
        action = await resolveConflict(item);
      } else {
        conflicts.push(item);
        applied.conflict++;
        continue;
      }
    }

    if (dryRun) {
      applied[action]++;
      continue;
    }

    try {
      const warning = await applyAction(
        client, outputDir, action, item, state, folders, fileNameTemplate,
      );
      if (warning) errors.push({ id: item.id, subject: item.subject, action, error: warning });
      applied[action]++;
      processed++;
      if (processed % SAVE_INTERVAL === 0) {
        state.lastSync = Date.now();
        await saveState(outputDir, state);
      }
    } catch (err) {
      const message = (err as Error).message;
      errors.push({ id: item.id, subject: item.subject, action, error: message });
      if (!quiet) {
        process.stderr.write(`\n❌ 处理失败 [${item.id}] ${action}: ${message}\n`);
      }
    }
  }

  if (!dryRun) {
    state.lastSync = Date.now();
    await saveState(outputDir, state);
  }

  return {
    total: plan.length,
    applied,
    conflicts,
    errors,
    outputDir,
    mode,
    dryRun,
  };
}

/**
 * 计划生成后本地文件又被改动（如交互询问期间用户编辑了文件）时中止该条，
 * 避免用过期的计划覆盖/删除新内容。
 */
async function assertLocalUnchanged(item: SyncPlanItem): Promise<void> {
  const current =
    item.filePath && (await fileExists(item.filePath))
      ? await readFile(item.filePath, "utf-8")
      : undefined;
  if (current !== item.localMarkdown) {
    throw new Error("本地文件在生成同步计划后又被修改，已跳过，请重新运行 sync");
  }
}

/** 选一个不会覆盖其他笔记文件的落盘路径 */
async function claimFilePath(
  desired: string,
  item: SyncPlanItem,
  state: SyncState,
  outputDir: string,
): Promise<string> {
  const key = pathKey(desired);
  if (item.filePath && pathKey(item.filePath) === key) return desired;
  const heldByOther = Object.values(state.notes).some(
    (n) =>
      n.id !== item.id &&
      n.filePath !== null &&
      pathKey(toOutputAbs(n.filePath, outputDir)) === key,
  );
  if (!heldByOther && !(await fileExists(desired))) return desired;
  return withIdSuffix(desired, item.id);
}

/**
 * 本地文件所在一级子目录 → 云端文件夹 id。
 * 优先沿用同目录下已同步笔记所在的文件夹（云端文件夹改名后本地目录名会过时），
 * 其次按名称匹配，都没有才新建。
 */
async function resolveFolderId(
  client: SyncClient,
  filePath: string | null,
  outputDir: string,
  folders: Record<string, RawFolderEntry>,
  state: SyncState,
): Promise<string> {
  if (!filePath) return "0";
  const parts = relative(outputDir, filePath).split(sep);
  if (parts.length < 2) return "0";
  const dirName = parts[0];
  const dirKey = pathKey(join(outputDir, dirName));
  for (const n of Object.values(state.notes)) {
    if (!n.folderId || !n.filePath || !folders[n.folderId]) continue;
    if (pathKey(dirname(toOutputAbs(n.filePath, outputDir))) === dirKey) return n.folderId;
  }
  for (const [id, folder] of Object.entries(folders)) {
    if (sanitizeFileName(folder.subject || "") === dirName) return id;
  }
  const created = await client.createFolder(dirName);
  const id = String(created.id);
  folders[id] = created;
  return id;
}

/** 执行单个动作并更新状态；动作已生效但有需要报告的问题时返回说明 */
async function applyAction(
  client: SyncClient,
  outputDir: string,
  action: SyncAction,
  item: SyncPlanItem,
  state: SyncState,
  folders: Record<string, RawFolderEntry>,
  fileNameTemplate: string | undefined,
): Promise<string | undefined> {
  const id = item.id;
  switch (action) {
    case "skip":
      return;

    case "update-local":
    case "create-local": {
      // 下行：用云端覆盖/创建本地
      if (!item.remote || item.remoteMarkdown === undefined) return;
      await assertLocalUnchanged(item);
      const note = parseNoteEntry(item.remote);
      const desired = getNoteFilePath(note, folders, outputDir, fileNameTemplate);
      const filePath = await claimFilePath(desired, item, state, outputDir);
      await ensureFileDir(filePath);
      await writeFile(filePath, item.remoteMarkdown, "utf-8");
      state.notes[id] = {
        id,
        subject: note.subject,
        filePath: toOutputRel(filePath, outputDir),
        folderId: note.folderId,
        baseHash: computeHash(item.remoteMarkdown),
        localHash: computeHash(item.remoteMarkdown),
        remoteModify: item.remote.modifyDate,
      };
      // 路径变化（改名/换文件夹）时清理旧文件
      if (
        item.filePath &&
        pathKey(item.filePath) !== pathKey(filePath) &&
        (await fileExists(item.filePath))
      ) {
        await rm(item.filePath, { force: true });
      }
      // 附件失败不回滚正文：一个坏附件不应让整篇笔记永远同步不下来
      const failedFiles = await downloadAttachments(client, note.files, outputDir);
      return failedFiles.length > 0 ? attachmentError(failedFiles) : undefined;
    }

    case "update-remote":
    case "create-remote": {
      // 上行：用本地内容更新/创建云端。item.filePath 为绝对路径，存状态前转相对 output。
      if (item.localMarkdown === undefined) return;
      await assertLocalUnchanged(item);
      const relPath = item.filePath ? toOutputRel(item.filePath, outputDir) : null;
      const prefix = item.filePath ? assetPrefixFor(item.filePath, outputDir) : "assets/";
      const baseDirs = item.filePath ? [dirname(item.filePath), outputDir] : [outputDir];
      const now = Date.now();
      if (action === "create-remote") {
        const { imageMap, uploaded } = await uploadLocalImages(
          client,
          item.localMarkdown,
          new Map(),
          baseDirs,
        );
        const xml = markdownToXml(item.localMarkdown, imageMap);
        const folderId = await resolveFolderId(client, item.filePath, outputDir, folders, state);
        const title = item.filePath
          ? titleFromPath(item.filePath, id)
          : firstLine(item.localMarkdown);
        const created = await client.createNote({
          colorId: 0,
          folderId,
          createDate: now,
          modifyDate: now,
          content: xml,
          alertDate: 0,
          setting: withAttachments(undefined, uploaded),
          extraInfo: buildExtraInfoString(title),
          snippet: extractSnippet(xml),
        });
        const newId = String(created.id);
        // 云端已删后重建会换新 id，旧记录必须移除，否则两条记录指向同一文件
        delete state.notes[id];
        state.notes[newId] = {
          id: newId,
          subject: title,
          filePath: relPath,
          folderId,
          baseHash: computeHash(item.localMarkdown),
          localHash: computeHash(item.localMarkdown),
          remoteModify: created.modifyDate,
        };
      } else {
        // update-remote：先取最新 entry 拿 tag，改 content 再提交
        const current = await client.getNote(id);
        // 计划生成后云端又被改过：直接提交会用新 tag 覆盖掉这次改动
        if (
          item.remote?.modifyDate !== undefined &&
          current.modifyDate !== item.remote.modifyDate
        ) {
          throw new Error("云端笔记在生成同步计划后又被修改，已跳过，请重新运行 sync");
        }
        const currentNote = parseNoteEntry(current);
        const { imageMap, uploaded } = await uploadLocalImages(
          client,
          item.localMarkdown,
          buildImageMap(currentNote.files, prefix, "assets/"),
          baseDirs,
        );
        const xml = markdownToXml(item.localMarkdown, imageMap);
        const entry: WriteNoteEntry = {
          id,
          tag: current.tag,
          status: current.status,
          createDate: current.createDate ?? now,
          modifyDate: now,
          colorId: current.colorId ?? 0,
          content: xml,
          setting: withAttachments(current.setting, uploaded),
          folderId: String(current.folderId ?? "0"),
          alertDate: current.alertDate ?? 0,
          extraInfo:
            typeof current.extraInfo === "string"
              ? current.extraInfo
              : undefined,
          subject: current.subject,
          snippet: extractSnippet(xml),
        };
        const updated = await client.updateNote(id, entry);
        state.notes[id] = {
          id,
          subject: state.notes[id]?.subject ?? currentNote.subject,
          filePath: relPath,
          folderId: currentNote.folderId,
          baseHash: computeHash(item.localMarkdown),
          localHash: computeHash(item.localMarkdown),
          remoteModify: updated.modifyDate,
        };
      }
      return;
    }

    case "delete-local": {
      await assertLocalUnchanged(item);
      if (item.filePath && (await fileExists(item.filePath))) {
        await rm(item.filePath, { force: true });
      }
      delete state.notes[id];
      return;
    }

    case "delete-remote": {
      // 同步里的删除只移到回收站：本地误删文件时仍可在云端恢复
      const tag = item.remote?.tag;
      if (!tag) throw new Error("云端笔记缺少 tag，无法删除");
      await client.deleteNote(id, tag, false);
      delete state.notes[id];
      return;
    }

    case "drop-state":
      delete state.notes[id];
      return;

    default:
      return;
  }
}

/** 本地文件名作为云端标题；去掉同名去重时加的 `_<id>` 后缀 */
function titleFromPath(filePath: string, id: string): string {
  let name = basename(filePath, ".md");
  const suffix = `_${id}`;
  if (!id.startsWith("local:") && name.endsWith(suffix) && name.length > suffix.length) {
    name = name.slice(0, -suffix.length);
  }
  return name.trim() || "未命名";
}

function firstLine(md: string): string {
  return (
    md
      .split("\n")
      .map((l) => l.replace(/^#+\s*/, "").trim())
      .find((l) => l.length > 0) ?? "未命名"
  );
}

/**
 * 扫描输出目录下的 Markdown 文件（含一级子目录即文件夹），跳过 assets/。
 * 用于发现「本地新增、尚未同步」的笔记文件。
 */
async function scanMarkdownFiles(outputDir: string): Promise<string[]> {
  const result: string[] = [];
  let topEntries;
  try {
    topEntries = await readdir(outputDir, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const ent of topEntries) {
    if (ent.name === "assets") continue;
    const full = join(outputDir, ent.name);
    if (ent.isFile() && ent.name.endsWith(".md")) {
      result.push(full);
    } else if (ent.isDirectory()) {
      try {
        const sub = await readdir(full, { withFileTypes: true });
        for (const s of sub) {
          if (s.isFile() && s.name.endsWith(".md")) {
            result.push(join(full, s.name));
          }
        }
      } catch {
        /* ignore unreadable subdir */
      }
    }
  }
  return result;
}

export type { SyncNoteState };
