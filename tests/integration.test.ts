import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { peekAuth } from "../src/auth.ts";
import { MiNoteClient } from "../src/client.ts";
import { exportNotes } from "../src/sync.ts";
import {
  markdownToXml,
  xmlToMarkdown,
  parseNoteEntry,
  extractSnippet,
} from "../src/converter.ts";
import { buildExtraInfoString } from "../src/note.ts";
import type { WriteNoteEntry } from "../src/types.ts";

/**
 * 真实 API 集成测试（需要有效登录态）。
 *
 * 运行：MI_NOTE_CLI_INTEGRATION=1 pnpm test:integration
 *
 * 所有写操作均带 [mi-note-cli-test] 前缀，并在结束时永久删除（purge），
 * 不会污染用户的真实笔记。
 */

const ENABLED = process.env.MI_NOTE_CLI_INTEGRATION === "1";
const PREFIX = "[mi-note-cli-test]";

let client: MiNoteClient | null = null;
let authError: string | null = null;

before(async () => {
  if (!ENABLED) return;
  const auth = await peekAuth();
  if (!auth) {
    authError = "无有效登录态（cookie 已过期）。请先运行 mi-note-cli login";
    return;
  }
  client = new MiNoteClient(auth);
});

function skipIfUnavailable(t: { skip: (msg?: string) => void }): boolean {
  if (!ENABLED) {
    t.skip("设置 MI_NOTE_CLI_INTEGRATION=1 以启用真实 API 集成测试");
    return true;
  }
  if (!client) {
    t.skip(authError ?? "无有效登录态，跳过集成测试");
    return true;
  }
  return false;
}

// ============ 读 ============

test("集成：列出笔记", async (t) => {
  if (skipIfUnavailable(t)) return;
  const { entries, folders } = await client!.getAllNotes();
  assert.ok(Array.isArray(entries), "entries 应为数组");
  assert.ok(typeof folders === "object", "folders 应为对象");
  console.error(`  → 共 ${entries.length} 条笔记，${Object.keys(folders).length} 个文件夹`);
});

// ============ 笔记写操作全链路（自清理） ============

test("集成：创建→读取→更新→置顶→永久删除", async (t) => {
  if (skipIfUnavailable(t)) return;

  const title = `${PREFIX} 标题-${Date.now()}`;
  const md = `# 测试标题\n\n这是一条 **集成测试** 笔记。\n\n- 项目一\n- 项目二\n\n- [ ] 待办\n- [x] 已完成`;
  const xml = markdownToXml(md);
  const now = Date.now();

  // 创建
  const entry: WriteNoteEntry = {
    colorId: 0,
    folderId: "0",
    createDate: now,
    modifyDate: now,
    content: xml,
    alertDate: 0,
    setting: { themeId: 0, stickyTime: 0, version: 0 },
    extraInfo: buildExtraInfoString(title),
    snippet: extractSnippet(xml),
  };
  const created = await client!.createNote(entry);
  const id = String(created.id);
  assert.ok(id, "应返回笔记 ID");
  console.error(`  → 创建笔记 ${id}`);

  try {
    // 读取并校验内容往返
    const fetched = await client!.getNote(id);
    const parsed = parseNoteEntry(fetched);
    const backMd = xmlToMarkdown(parsed.content, parsed.files);
    assert.ok(backMd.includes("测试标题"), "应包含标题文本");
    assert.ok(backMd.includes("集成测试"), "应包含正文");
    assert.ok(backMd.includes("- 项目一"), "应包含列表");
    assert.ok(/- \[[ x]\]/.test(backMd), "应包含复选框");

    // 更新内容
    const newMd = `# 已更新\n\n更新后的正文`;
    const newXml = markdownToXml(newMd);
    const updateEntry: WriteNoteEntry = {
      id,
      tag: fetched.tag,
      status: fetched.status,
      createDate: fetched.createDate ?? now,
      modifyDate: Date.now(),
      colorId: fetched.colorId ?? 0,
      content: newXml,
      setting: fetched.setting ?? { themeId: 0, stickyTime: 0, version: 0 },
      folderId: String(fetched.folderId ?? "0"),
      alertDate: fetched.alertDate ?? 0,
      extraInfo: buildExtraInfoString(`${PREFIX} 已更新`, typeof fetched.extraInfo === "string" ? fetched.extraInfo : undefined),
      subject: fetched.subject,
      snippet: extractSnippet(newXml),
    };
    await client!.updateNote(id, updateEntry);

    const afterUpdate = await client!.getNote(id);
    const updatedMd = xmlToMarkdown(parseNoteEntry(afterUpdate).content);
    assert.ok(updatedMd.includes("已更新"), "更新后应包含新内容");
    console.error(`  → 更新笔记 ${id} 成功`);

    // 置顶（修改 stickyTime）
    const pinEntry: WriteNoteEntry = {
      id,
      tag: afterUpdate.tag,
      status: afterUpdate.status,
      createDate: afterUpdate.createDate ?? now,
      modifyDate: Date.now(),
      colorId: afterUpdate.colorId ?? 0,
      content: afterUpdate.content ?? "",
      setting: {
        themeId: afterUpdate.setting?.themeId ?? 0,
        stickyTime: Date.now(),
        version: afterUpdate.setting?.version ?? 0,
      },
      folderId: String(afterUpdate.folderId ?? "0"),
      alertDate: afterUpdate.alertDate ?? 0,
      subject: afterUpdate.subject,
      snippet: afterUpdate.snippet,
    };
    await client!.updateNote(id, pinEntry);
    console.error(`  → 置顶笔记 ${id} 成功`);
  } finally {
    // 清理：永久删除
    const latest = await client!.getNote(id);
    await client!.deleteNote(id, latest.tag, true);
    console.error(`  → 已永久删除测试笔记 ${id}`);
  }
});

// ============ 文件夹写操作（自清理） ============

test("集成：创建文件夹→重命名→删除", async (t) => {
  if (skipIfUnavailable(t)) return;

  const name = `${PREFIX} 文件夹-${Date.now()}`;
  const folder = await client!.createFolder(name);
  const fid = String(folder.id);
  assert.ok(fid, "应返回文件夹 ID");
  console.error(`  → 创建文件夹 ${fid}`);

  try {
    // 重命名（需要最新 tag，从列表中取）
    const { folders } = await client!.getAllNotes();
    const current = folders[fid];
    assert.ok(current, "应能在列表中找到新建文件夹");

    await client!.updateFolder(fid, {
      id: fid,
      tag: current.tag,
      status: current.status,
      createDate: current.createDate ?? Date.now(),
      modifyDate: Date.now(),
      colorId: current.colorId ?? 0,
      type: "folder",
      folderId: String(current.folderId ?? "0"),
      subject: `${PREFIX} 已重命名`,
      setting: current.setting ?? { themeId: 0, stickyTime: 0, version: 0 },
    });
    console.error(`  → 重命名文件夹 ${fid} 成功`);
  } finally {
    // 清理：取最新 tag 后永久删除
    const { folders } = await client!.getAllNotes();
    const latest = folders[fid];
    if (latest?.tag) {
      await client!.deleteFolder(fid, latest.tag, true);
      console.error(`  → 已永久删除测试文件夹 ${fid}`);
    }
  }
});

// ============ 图片上传（自清理：上传后随笔记一起删除） ============

test("集成：上传图片并嵌入笔记", async (t) => {
  if (skipIfUnavailable(t)) return;

  // 1x1 PNG（最小合法 PNG）
  const pngBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const buffer = new Uint8Array(Buffer.from(pngBase64, "base64"));

  const { fileId } = await client!.uploadImage(buffer, {
    filename: "test-pixel.png",
    mimeType: "image/png",
  });
  assert.ok(fileId, "应返回 fileId");
  console.error(`  → 上传图片成功 fileId=${fileId}`);

  // 把图片嵌入一条新笔记，验证 minote://image 引用可被转换
  const md = `${PREFIX} 带图笔记\n\n![图](minote://image/${fileId})`;
  const xml = markdownToXml(md);
  assert.ok(xml.includes(`fileid="${fileId}"`), "XML 应包含图片引用");

  const now = Date.now();
  const created = await client!.createNote({
    colorId: 0,
    folderId: "0",
    createDate: now,
    modifyDate: now,
    content: xml,
    alertDate: 0,
    setting: { themeId: 0, stickyTime: 0, version: 0 },
    extraInfo: buildExtraInfoString(`${PREFIX} 带图笔记`),
    snippet: extractSnippet(xml),
  });
  const id = String(created.id);
  console.error(`  → 创建带图笔记 ${id}`);

  // 清理
  const latest = await client!.getNote(id);
  await client!.deleteNote(id, latest.tag, true);
  console.error(`  → 已永久删除带图测试笔记 ${id}`);
});

// ============ sync 双向同步全链路 ============

test("集成：sync 双向（云端创建→下行→改本地→上行→校验云端）", async (t) => {
  if (skipIfUnavailable(t)) return;

  // 隔离配置目录，避免污染真实公共配置
  const cfgDir = await mkdtemp(join(tmpdir(), "mi-note-cli-cfg-"));
  const outDir = await mkdtemp(join(tmpdir(), "mi-note-cli-sync-"));
  const prevCfg = process.env.MI_NOTE_CLI_CONFIG_DIR;
  process.env.MI_NOTE_CLI_CONFIG_DIR = cfgDir;

  const { buildSyncPlan, executeSyncPlan } = await import("../src/sync.ts");

  // 在云端创建一条测试笔记
  const xml = markdownToXml(`# ${PREFIX} sync原始\n\n初始正文`);
  const now = Date.now();
  const created = await client!.createNote({
    colorId: 0,
    folderId: "0",
    createDate: now,
    modifyDate: now,
    content: xml,
    alertDate: 0,
    setting: { themeId: 0, stickyTime: 0, version: 0 },
    extraInfo: buildExtraInfoString(`${PREFIX} sync原始`),
    snippet: extractSnippet(xml),
  });
  const id = String(created.id);
  console.error(`  → 云端创建 ${id}`);

  try {
    // 1) 下行：two-way 模式应把云端新笔记拉到本地（create-local）
    {
      const { plan, state, folders } = await buildSyncPlan(client!, outDir, "two-way", true);
      const item = plan.find((p) => p.id === id);
      assert.ok(item, "计划应包含新笔记");
      assert.equal(item!.action, "create-local", "云端新笔记应下行创建本地");
      await executeSyncPlan(client!, outDir, "two-way", plan, state, folders, { quiet: true });
    }

    // 找到本地文件
    const filesAfterDown = await readdir(outDir);
    const localFile = filesAfterDown.find((f) => f.includes("sync原始") && f.endsWith(".md"));
    assert.ok(localFile, "本地应生成对应 md 文件");
    const localPath = join(outDir, localFile!);
    console.error(`  → 已下行到本地 ${localFile}`);

    // 2) 改本地内容
    await writeFile(localPath, `# ${PREFIX} sync原始\n\n本地修改后的正文`, "utf-8");

    // 3) 上行：two-way 模式应检测到 local-changed 并 update-remote
    {
      const { plan, state, folders } = await buildSyncPlan(client!, outDir, "two-way", true);
      const item = plan.find((p) => p.id === id);
      assert.ok(item, "计划应包含被改笔记");
      assert.equal(item!.scenario, "local-changed", "应识别为仅本地改");
      assert.equal(item!.action, "update-remote", "应上行更新云端");
      await executeSyncPlan(client!, outDir, "two-way", plan, state, folders, { quiet: true });
    }
    console.error(`  → 已上行更新云端`);

    // 4) 校验云端内容已更新
    const fetched = await client!.getNote(id);
    const cloudMd = xmlToMarkdown(parseNoteEntry(fetched).content);
    assert.ok(cloudMd.includes("本地修改后的正文"), "云端应已更新为本地内容");
    console.error(`  → 校验通过：云端已同步本地修改`);
  } finally {
    // 清理：删云端笔记 + 临时目录 + 恢复 env
    try {
      const latest = await client!.getNote(id);
      await client!.deleteNote(id, latest.tag, true);
      console.error(`  → 已永久删除云端测试笔记 ${id}`);
    } catch {
      /* ignore */
    }
    await rm(outDir, { recursive: true, force: true });
    await rm(cfgDir, { recursive: true, force: true });
    if (prevCfg === undefined) delete process.env.MI_NOTE_CLI_CONFIG_DIR;
    else process.env.MI_NOTE_CLI_CONFIG_DIR = prevCfg;
  }
});

// ============ sync 本地新增文件上行（#6） ============

test("集成：sync 本地新增 .md 文件应上行创建云端", async (t) => {
  if (skipIfUnavailable(t)) return;

  const cfgDir = await mkdtemp(join(tmpdir(), "mi-note-cli-cfg2-"));
  const outDir = await mkdtemp(join(tmpdir(), "mi-note-cli-sync2-"));
  const prevCfg = process.env.MI_NOTE_CLI_CONFIG_DIR;
  process.env.MI_NOTE_CLI_CONFIG_DIR = cfgDir;

  const { buildSyncPlan, executeSyncPlan } = await import("../src/sync.ts");
  let createdId: string | undefined;

  try {
    // 在本地目录直接放一个全新的 .md 文件（从未同步过）
    const marker = `${PREFIX} 本地新增 ${Date.now()}`;
    await writeFile(join(outDir, "新笔记.md"), `# ${marker}\n\n本地直接创建的内容`, "utf-8");

    // upload 模式：本地新增应被检测为 local-new 并 create-remote
    const { plan, state, folders } = await buildSyncPlan(client!, outDir, "upload", true);
    const item = plan.find((p) => p.localMarkdown?.includes(marker));
    assert.ok(item, "应检测到本地新增文件");
    assert.equal(item!.scenario, "local-new", "应分类为本地新增");
    assert.equal(item!.action, "create-remote", "upload 模式应上行创建云端");

    await executeSyncPlan(client!, outDir, "upload", plan, state, folders, { quiet: true });

    // 校验云端确实新建了这条笔记
    const { entries } = await client!.getAllNotes();
    const found = entries.find((e) => (e.snippet ?? "").includes("本地新增") || String(e.subject ?? "").includes("本地新增"));
    // 通过状态拿到新建的 id 更可靠
    const cfg = JSON.parse(await readFile(join(cfgDir, "config.json"), "utf-8"));
    const dirState = cfg.syncs[outDir] ?? Object.values(cfg.syncs)[0];
    const ids = Object.keys(dirState?.notes ?? {});
    assert.ok(ids.length > 0, "状态应记录新建笔记的 id");
    createdId = ids[0];
    const detail = await client!.getNote(createdId!);
    const cloudMd = xmlToMarkdown(parseNoteEntry(detail).content);
    assert.ok(cloudMd.includes("本地直接创建的内容"), "云端应包含本地新增内容");
    void found;
    console.error(`  → 本地新增已上行创建云端 ${createdId}`);
  } finally {
    if (createdId) {
      try {
        const latest = await client!.getNote(createdId);
        await client!.deleteNote(createdId, latest.tag, true);
        console.error(`  → 已永久删除云端测试笔记 ${createdId}`);
      } catch {
        /* ignore */
      }
    }
    await rm(outDir, { recursive: true, force: true });
    await rm(cfgDir, { recursive: true, force: true });
    if (prevCfg === undefined) delete process.env.MI_NOTE_CLI_CONFIG_DIR;
    else process.env.MI_NOTE_CLI_CONFIG_DIR = prevCfg;
  }
});
