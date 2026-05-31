import { getClient } from "./shared.js";
import { isJsonMode, success, logInfo, fail, confirm } from "../output.js";

import type { WriteFolderEntry, RawFolderEntry } from "../types.js";

/** 列出所有文件夹 */
export async function foldersCommand(): Promise<void> {
  try {
    const client = await getClient();
    const { folders } = await client.getAllNotes(200);
    process.stderr.write("\r");

    const list = (Object.values(folders) as RawFolderEntry[]).map((f) => ({
      id: String(f.id),
      subject: f.subject ?? "",
      parentId: String(f.folderId ?? "0"),
    }));

    success(list, () => {
      if (list.length === 0) {
        logInfo("（无文件夹）");
        return;
      }
      for (const f of list) {
        process.stdout.write(`[${f.id}] ${f.subject}\n`);
      }
      logInfo(`\n共 ${list.length} 个文件夹`);
    });
  } catch (err) {
    fail(err);
  }
}

/** 创建文件夹 */
export async function folderCreateCommand(
  name: string,
  opts: { parent?: string },
): Promise<void> {
  try {
    const client = await getClient();
    const folder = await client.createFolder(name, opts.parent ?? "0");
    success({ id: String(folder.id), subject: name }, () => {
      logInfo(`✅ 文件夹创建成功：[${folder.id}] ${name}`);
    });
  } catch (err) {
    fail(err);
  }
}

/** 重命名文件夹 */
export async function folderRenameCommand(
  id: string,
  name: string,
): Promise<void> {
  try {
    const client = await getClient();
    const { folders } = await client.getAllNotes(200);
    process.stderr.write("\r");
    const folder = folders[id];
    if (!folder) throw new Error(`未找到文件夹：${id}`);

    const entry: WriteFolderEntry = {
      id: String(folder.id),
      tag: folder.tag,
      status: folder.status,
      createDate: folder.createDate ?? Date.now(),
      modifyDate: Date.now(),
      colorId: folder.colorId ?? 0,
      type: "folder",
      folderId: String(folder.folderId ?? "0"),
      subject: name,
      setting: folder.setting ?? { themeId: 0, stickyTime: 0, version: 0 },
    };

    await client.updateFolder(id, entry);
    success({ id, subject: name }, () => {
      logInfo(`✅ 文件夹 ${id} 已重命名为「${name}」`);
    });
  } catch (err) {
    fail(err);
  }
}

/** 删除文件夹 */
export async function folderDeleteCommand(
  id: string,
  opts: { purge?: boolean; yes?: boolean },
): Promise<void> {
  try {
    const client = await getClient();
    const { folders } = await client.getAllNotes(200);
    process.stderr.write("\r");
    const folder = folders[id];
    if (!folder) throw new Error(`未找到文件夹：${id}`);
    if (!folder.tag) throw new Error("文件夹缺少 tag 字段，无法删除");

    if (!opts.yes && !isJsonMode()) {
      const action = opts.purge ? "永久删除" : "删除";
      logInfo(`📁 文件夹: ${folder.subject ?? ""} [${id}]`);
      const ok = await confirm(
        `确认要${action}该文件夹吗？（文件夹内笔记也会一并处理）(y/N) `,
      );
      if (!ok) {
        logInfo("已取消");
        return;
      }
    }

    await client.deleteFolder(id, folder.tag, opts.purge ?? false);
    success({ id, purged: opts.purge ?? false }, () => {
      logInfo(opts.purge ? `✅ 文件夹 ${id} 已永久删除` : `✅ 文件夹 ${id} 已删除`);
    });
  } catch (err) {
    fail(err);
  }
}
