import type { SyncMode } from "./types.js";

/**
 * 3-way diff 与 mode 决策（纯函数，无 IO，便于单测全覆盖）。
 *
 * 三方：
 * - base：上次同步成功时的基线（baseHash / 是否存在）
 * - remote：云端当前（内容哈希 / 是否存在）
 * - local：本地当前（内容哈希 / 是否存在）
 *
 * 通过与 base 对比，判定每一侧"未变 / 改了 / 删了 / 新增"，归类为场景 #1~#11。
 */

/** 单条笔记的三方输入 */
export interface ThreeWayInput {
  /** 基线哈希；undefined 表示上次同步时不存在该笔记（无基线） */
  baseHash?: string;
  /** 云端当前内容哈希；undefined 表示云端不存在（已删或从未有） */
  remoteHash?: string;
  /** 本地当前内容哈希；undefined 表示本地不存在（已删或从未有） */
  localHash?: string;
}

/** 场景分类（对应设计文档矩阵 #1~#11） */
export type Scenario =
  | "in-sync" // #1 三方一致
  | "remote-changed" // #2 仅云端改
  | "local-changed" // #3 仅本地改
  | "both-changed" // #4 双改冲突
  | "remote-new" // #5 云端新增
  | "local-new" // #6 本地新增
  | "remote-deleted-local-clean" // #7 云删本地未改
  | "remote-deleted-local-changed" // #8 云删本地改（冲突）
  | "local-deleted-remote-clean" // #9 本地删云未改
  | "local-deleted-remote-changed" // #10 本地删云改（冲突）
  | "both-deleted"; // #11 两端都删

/** 同步动作 */
export type SyncAction =
  | "skip" // 无需动作
  | "update-local" // 下行：用云端内容覆盖本地
  | "update-remote" // 上行：用本地内容更新云端
  | "create-local" // 下行：在本地创建
  | "create-remote" // 上行：在云端创建
  | "delete-local" // 删除本地文件
  | "delete-remote" // 删除云端笔记
  | "drop-state" // 仅清理状态记录（两端都已不存在）
  | "conflict"; // 真冲突，交由调用方（询问用户 / 跳过并报告）

/**
 * 判定三方差异属于哪个场景。
 */
export function classify(input: ThreeWayInput): Scenario {
  const { baseHash, remoteHash, localHash } = input;
  const hasBase = baseHash !== undefined;
  const hasRemote = remoteHash !== undefined;
  const hasLocal = localHash !== undefined;

  // 无基线：本次是新关系
  if (!hasBase) {
    if (hasRemote && !hasLocal) return "remote-new"; // #5
    if (!hasRemote && hasLocal) return "local-new"; // #6
    if (hasRemote && hasLocal) {
      // 两端都新出现：内容相同视为已同步，不同视为双改冲突
      return remoteHash === localHash ? "in-sync" : "both-changed";
    }
    return "in-sync"; // 三方皆无，理论上不会发生
  }

  // 有基线
  const remoteChanged = hasRemote && remoteHash !== baseHash;
  const localChanged = hasLocal && localHash !== baseHash;

  // 删除判定（相对基线消失）
  if (!hasRemote && !hasLocal) return "both-deleted"; // #11
  if (!hasRemote && hasLocal) {
    return localChanged
      ? "remote-deleted-local-changed" // #8
      : "remote-deleted-local-clean"; // #7
  }
  if (hasRemote && !hasLocal) {
    return remoteChanged
      ? "local-deleted-remote-changed" // #10
      : "local-deleted-remote-clean"; // #9
  }

  // 两端都存在
  if (!remoteChanged && !localChanged) return "in-sync"; // #1
  if (remoteChanged && !localChanged) return "remote-changed"; // #2
  if (!remoteChanged && localChanged) return "local-changed"; // #3
  // 两端都相对基线变了：若变成相同内容则已自然一致，否则才是双改冲突
  return remoteHash === localHash ? "in-sync" : "both-changed"; // #4
}

/**
 * 给定场景 + 模式，决定要执行的动作。
 *
 * 设计要点：
 * - 非冲突场景（#2/#3/#5/#6/#7/#9）方向明确，按 mode 的"是否允许下行/上行/删除"裁剪。
 * - 冲突场景（#4/#8/#10）：有明确优先方的 mode（download/mirror/upload）按优先方解决；
 *   manual / two-way 返回 `conflict`，交由调用方处理（交互询问或非交互跳过报告）。
 */
export function decide(scenario: Scenario, mode: SyncMode): SyncAction {
  switch (scenario) {
    case "in-sync":
      return "skip";

    case "remote-changed": // #2 仅云端改
      // 除 upload（本地优先、忽略云端变更）外都下行
      return mode === "upload" ? "skip" : "update-local";

    case "local-changed": // #3 仅本地改
      // 只有会上行的模式才更新云端
      return mode === "upload" || mode === "two-way"
        ? "update-remote"
        : mode === "manual"
          ? "conflict" // manual 任何不一致都问
          : "skip"; // download / mirror 不上行

    case "remote-new": // #5 云端新增
      return mode === "upload" ? "skip" : "create-local";

    case "local-new": // #6 本地新增
      return mode === "upload" || mode === "two-way"
        ? "create-remote"
        : mode === "manual"
          ? "conflict"
          : "skip"; // download / mirror 不上行

    case "remote-deleted-local-clean": // #7 云删本地未改
      // 删本地以跟随云端；upload 模式视本地为权威，反而重建云端
      if (mode === "upload") return "create-remote";
      if (mode === "manual") return "conflict";
      return "delete-local";

    case "local-deleted-remote-clean": // #9 本地删云未改
      // 删云端以跟随本地；download/mirror 视云端为权威，反而重建本地
      if (mode === "download" || mode === "mirror") return "create-local";
      if (mode === "manual") return "conflict";
      return "delete-remote"; // upload / two-way

    case "both-deleted": // #11
      return "drop-state";

    // ---- 真冲突场景 ----
    case "both-changed": // #4 双改
    case "remote-deleted-local-changed": // #8 云删本地改
    case "local-deleted-remote-changed": // #10 本地删云改
      return resolveConflict(scenario, mode);

    default:
      return "skip";
  }
}

/**
 * 冲突场景的解决：有明确优先方的 mode 直接裁决；manual/two-way 交回 conflict。
 */
function resolveConflict(scenario: Scenario, mode: SyncMode): SyncAction {
  switch (mode) {
    case "download":
    case "mirror":
      // 云端优先
      if (scenario === "remote-deleted-local-changed") return "delete-local"; // 云端已删→本地也删
      return "update-local"; // both-changed / local-deleted-remote-changed → 取云端
    case "upload":
      // 本地优先
      if (scenario === "local-deleted-remote-changed") return "delete-remote"; // 本地已删→云端也删
      return "update-remote"; // both-changed / remote-deleted-local-changed → 取本地
    case "two-way":
    case "manual":
    default:
      return "conflict"; // 交由调用方：交互询问或非交互跳过报告
  }
}
