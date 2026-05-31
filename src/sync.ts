import { readFile, writeFile, rm, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve as resolvePath } from "node:path";
import { MiNoteClient } from "./client.js";
import {
  parseNoteEntry,
  xmlToMarkdown,
  markdownToXml,
  extractSnippet,
  getNoteFilePath,
} from "./converter.js";
import { buildExtraInfoString } from "./note.js";
import { randomDelay, ensureFileDir, fileExists, ensureDir } from "./utils.js";
import { logInfo } from "./output.js";
import { loadDirState, saveDirState, toRelPath, toAbsPath } from "./config.js";
import { classify, decide } from "./sync-diff.js";
import type {
  RawNoteEntry,
  RawFolderEntry,
  AppConfig,
  SyncNoteState,
  SyncMode,
  WriteNoteEntry,
} from "./types.js";
import type { Scenario, SyncAction } from "./sync-diff.js";

const SAVE_INTERVAL = 10;

export function computeHash(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

// ============================================================
// export：纯单向 云→本地 快照。永不修改云端，不依赖/不写同步状态。
// ============================================================

export interface ExportResult {
  total: number;
  written: number;
  skipped: number;
  empty: number;
  failed: number;
  outputDir: string;
}

/**
 * 导出全部笔记为本地 Markdown（单向、只读云端）。
 *
 * - 拉取云端全部笔记 → 转 Markdown → 写本地（按文件夹组织）
 * - 下载附件到 assets/
 * - force=false 时跳过内容未变的笔记（按本地文件哈希比对，纯本地判断）
 * - 不删除任何云端笔记；不因本地缺失而回写云端
 */
export async function exportNotes(
  client: MiNoteClient,
  outputDir: string,
  force = false,
  quiet = false,
): Promise<ExportResult> {
  const log = (msg: string): void => {
    if (!quiet) logInfo(msg);
  };

  log("📂 开始导出...");
  const { entries, folders } = await client.getAllNotes(200, (count) => {
    if (!quiet) process.stderr.write(`\r📋 已获取 ${count} 条笔记...`);
  });
  if (!quiet) process.stderr.write(`\r📋 共获取 ${entries.length} 条笔记\n`);

  await ensureDir(outputDir);
  await ensureDir(join(outputDir, "assets"));

  let written = 0;
  let skipped = 0;
  let emptyCount = 0;
  let failed = 0;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!quiet) {
      const pct = (((i + 1) / entries.length) * 100).toFixed(1);
      process.stderr.write(`\r⏳ 导出中... ${i + 1}/${entries.length} (${pct}%)`);
    }
    try {
      const detail = await client.getNote(entry.id);
      const note = parseNoteEntry(detail);
      const markdown = xmlToMarkdown(note.content, note.files);

      if (!markdown.trim()) {
        emptyCount++;
        continue;
      }

      const filePath = getNoteFilePath(note, folders, outputDir);
      // 增量：本地已存在且内容相同则跳过
      if (!force && (await fileExists(filePath))) {
        const existing = await readFile(filePath, "utf-8");
        if (computeHash(existing) === computeHash(markdown)) {
          skipped++;
          continue;
        }
      }

      await ensureFileDir(filePath);
      await writeFile(filePath, markdown, "utf-8");
      for (const file of note.files) {
        await client.downloadFile(file.fileId, join(outputDir, "assets", file.name));
      }
      written++;
      await randomDelay(300);
    } catch (err) {
      failed++;
      if (!quiet) {
        process.stderr.write(`\n❌ 导出失败 [${entry.id}]: ${(err as Error).message}\n`);
      }
    }
  }

  if (!quiet) {
    process.stderr.write("\n");
    log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 导出完成
  总笔记数: ${entries.length}
  写入:     ${written}
  未修改:   ${skipped}
  空笔记:   ${emptyCount}
  失败:     ${failed}
  输出目录: ${outputDir}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  }

  return { total: entries.length, written, skipped, empty: emptyCount, failed, outputDir };
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

export interface SyncResult {
  total: number;
  applied: Record<SyncAction, number>;
  conflicts: SyncPlanItem[];
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
 * 纯读取，不产生副作用，便于 dry-run 与测试。
 */
export async function buildSyncPlan(
  client: MiNoteClient,
  outputDir: string,
  mode: SyncMode,
  quiet = false,
): Promise<{
  plan: SyncPlanItem[];
  state: AppConfig;
  folders: Record<string, RawFolderEntry>;
}> {
  const state = await loadDirState(outputDir);

  const { entries, folders } = await client.getAllNotes(200, (count) => {
    if (!quiet) process.stderr.write(`\r📋 已获取 ${count} 条笔记...`);
  });
  if (!quiet) process.stderr.write("\r");

  const remoteById = new Map<string, RawNoteEntry>();
  for (const e of entries) remoteById.set(String(e.id), e);

  // 收集所有涉及的 id：云端的 ∪ 状态里记录过的
  const allIds = new Set<string>([
    ...remoteById.keys(),
    ...Object.keys(state.notes),
  ]);

  const plan: SyncPlanItem[] = [];

  for (const id of allIds) {
    const remote = remoteById.get(id);
    const base = state.notes[id];

    // 先读本地（不依赖网络）。state 里 filePath 为相对项目根路径，读写时转绝对。
    let localMarkdown: string | undefined;
    let localHash: string | undefined;
    const relFilePath = base?.filePath ?? null;
    const filePath = relFilePath ? toAbsPath(relFilePath) : null;
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
    if (remote) {
      remoteDetail = await client.getNote(id);
      const note = parseNoteEntry(remoteDetail);
      remoteMarkdown = xmlToMarkdown(note.content, note.files);
      remoteHash = computeHash(remoteMarkdown);
    }

    const scenario = classify({
      baseHash: base?.baseHash,
      remoteHash,
      localHash,
    });
    const action = decide(scenario, mode);

    if (scenario === "in-sync") continue; // 无需动作不入计划

    plan.push({
      id,
      subject:
        (remoteDetail && parseNoteEntry(remoteDetail).subject) ||
        base?.subject ||
        id,
      scenario,
      action,
      remote: remoteDetail ?? remote,
      filePath,
      localMarkdown,
      remoteMarkdown,
    });
  }

  // 检测「本地新增文件」(#6)：输出目录下未被状态记录的 .md 文件。
  // 这些文件既不在云端 id 也不在状态 id 中，需单独扫描才能被上行同步发现。
  // state 里 filePath 为相对项目根路径，比对前统一转绝对。
  const trackedPaths = new Set<string>();
  for (const n of Object.values(state.notes)) {
    if (n.filePath) trackedPaths.add(toAbsPath(n.filePath));
  }
  const localFiles = await scanMarkdownFiles(outputDir);
  for (const fp of localFiles) {
    if (trackedPaths.has(resolvePath(fp))) continue; // 已跟踪
    const localMarkdown = await readFile(fp, "utf-8");
    if (!localMarkdown.trim()) continue; // 空文件忽略
    // 无 base、无 remote、有 local → classify 为 local-new
    const scenario = classify({ localHash: computeHash(localMarkdown) });
    const action = decide(scenario, mode);
    // 用文件路径作为计划项的临时标识（尚无云端 id）
    plan.push({
      id: `local:${fp}`,
      subject: firstLine(localMarkdown),
      scenario,
      action,
      filePath: fp,
      localMarkdown,
    });
  }

  return { plan, state, folders };
}

/**
 * 执行同步计划。
 * @param resolveConflict 遇到 action==="conflict" 时调用；不提供则跳过并计入冲突列表
 */
export async function executeSyncPlan(
  client: MiNoteClient,
  outputDir: string,
  mode: SyncMode,
  plan: SyncPlanItem[],
  state: AppConfig,
  folders: Record<string, RawFolderEntry>,
  opts: { dryRun?: boolean; quiet?: boolean; resolveConflict?: ConflictResolver } = {},
): Promise<SyncResult> {
  const { dryRun = false, quiet = false, resolveConflict } = opts;
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
      await applyAction(client, outputDir, action, item, state, folders);
      applied[action]++;
      processed++;
      if (processed % SAVE_INTERVAL === 0) {
        state.lastSync = Date.now();
        await saveDirState(state);
      }
    } catch (err) {
      if (!quiet) {
        process.stderr.write(
          `\n❌ 处理失败 [${item.id}] ${action}: ${(err as Error).message}\n`,
        );
      }
    }
  }

  if (!dryRun) {
    state.lastSync = Date.now();
    await saveDirState(state);
  }

  return {
    total: plan.length,
    applied,
    conflicts,
    outputDir,
    mode,
    dryRun,
  };
}

/** 执行单个动作并更新状态 */
async function applyAction(
  client: MiNoteClient,
  outputDir: string,
  action: SyncAction,
  item: SyncPlanItem,
  state: AppConfig,
  folders: Record<string, RawFolderEntry>,
): Promise<void> {
  const id = item.id;
  switch (action) {
    case "skip":
      return;

    case "update-local":
    case "create-local": {
      // 下行：用云端覆盖/创建本地
      if (!item.remote || item.remoteMarkdown === undefined) return;
      const note = parseNoteEntry(item.remote);
      const filePath = getNoteFilePath(note, folders, outputDir); // 绝对路径
      // 路径变化时清理旧文件（state 里 filePath 为相对，转绝对再比对/删除）
      const oldRel = state.notes[id]?.filePath;
      const oldPath = oldRel ? toAbsPath(oldRel) : null;
      if (oldPath && oldPath !== filePath && (await fileExists(oldPath))) {
        await rm(oldPath, { force: true });
      }
      await ensureFileDir(filePath);
      await writeFile(filePath, item.remoteMarkdown, "utf-8");
      for (const f of note.files) {
        await client.downloadFile(f.fileId, join(outputDir, "assets", f.name));
      }
      state.notes[id] = {
        id,
        subject: note.subject,
        filePath: toRelPath(filePath),
        baseHash: computeHash(item.remoteMarkdown),
        localHash: computeHash(item.remoteMarkdown),
        remoteModify: item.remote.modifyDate,
      };
      return;
    }

    case "update-remote":
    case "create-remote": {
      // 上行：用本地内容更新/创建云端。item.filePath 为绝对路径，存状态前转相对。
      if (item.localMarkdown === undefined) return;
      const relPath = item.filePath ? toRelPath(item.filePath) : null;
      const xml = markdownToXml(item.localMarkdown);
      const now = Date.now();
      if (action === "create-remote") {
        const created = await client.createNote({
          colorId: 0,
          folderId: "0",
          createDate: now,
          modifyDate: now,
          content: xml,
          alertDate: 0,
          setting: { themeId: 0, stickyTime: 0, version: 0 },
          extraInfo: buildExtraInfoString(firstLine(item.localMarkdown)),
          snippet: extractSnippet(xml),
        });
        const newId = String(created.id);
        state.notes[newId] = {
          id: newId,
          subject: firstLine(item.localMarkdown),
          filePath: relPath,
          baseHash: computeHash(item.localMarkdown),
          localHash: computeHash(item.localMarkdown),
          remoteModify: created.modifyDate,
        };
      } else {
        // update-remote：先取最新 entry 拿 tag，改 content 再提交
        const current = await client.getNote(id);
        const entry: WriteNoteEntry = {
          id,
          tag: current.tag,
          status: current.status,
          createDate: current.createDate ?? now,
          modifyDate: now,
          colorId: current.colorId ?? 0,
          content: xml,
          setting: current.setting ?? { themeId: 0, stickyTime: 0, version: 0 },
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
          subject: state.notes[id]?.subject ?? id,
          filePath: relPath,
          baseHash: computeHash(item.localMarkdown),
          localHash: computeHash(item.localMarkdown),
          remoteModify: updated.modifyDate,
        };
      }
      return;
    }

    case "delete-local": {
      if (item.filePath && (await fileExists(item.filePath))) {
        await rm(item.filePath, { force: true });
      }
      delete state.notes[id];
      return;
    }

    case "delete-remote": {
      if (item.remote?.tag) {
        await client.deleteNote(id, item.remote.tag, true);
      }
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
