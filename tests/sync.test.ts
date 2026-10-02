import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, readdir, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSyncPlan,
  executeSyncPlan,
  exportNotes,
  computeHash,
  type SyncClient,
} from "../src/sync.ts";
import { loadState, saveState } from "../src/config.ts";
import { fileExists } from "../src/utils.ts";
import type {
  RawNoteEntry,
  RawFolderEntry,
  SyncMode,
  WriteNoteEntry,
} from "../src/types.ts";

/**
 * src/sync.ts 执行层测试：用内存假客户端代替小米 API，零网络依赖。
 * 通过 MI_NOTE_CLI_CONFIG_DIR 把用户配置隔离到临时目录。
 */

let root: string;
let outputDir: string;
let cachePath: string;
let prevEnv: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mi-note-cli-synctest-"));
  outputDir = join(root, "notes");
  cachePath = join(root, "export-cache.json");
  prevEnv = process.env.MI_NOTE_CLI_CONFIG_DIR;
  process.env.MI_NOTE_CLI_CONFIG_DIR = root;
});

afterEach(async () => {
  if (prevEnv === undefined) delete process.env.MI_NOTE_CLI_CONFIG_DIR;
  else process.env.MI_NOTE_CLI_CONFIG_DIR = prevEnv;
  await rm(root, { recursive: true, force: true });
});

const IMAGE_ID = "1234.abcdEFG";

class FakeClient implements SyncClient {
  notes = new Map<string, RawNoteEntry>();
  folders: Record<string, RawFolderEntry> = {};
  updates: { id: string; entry: WriteNoteEntry }[] = [];
  creates: WriteNoteEntry[] = [];
  deletes: { id: string; tag?: string; purge: boolean }[] = [];
  createdFolders: string[] = [];
  uploads: string[] = [];
  getNoteCalls: string[] = [];
  failDownloads = false;
  private nextId = 9000;
  private clock = 1_700_000_000_000;

  add(id: string, title: string, content: string, extra: Partial<RawNoteEntry> = {}): RawNoteEntry {
    const entry: RawNoteEntry = {
      id,
      tag: `tag-${id}-1`,
      status: "normal",
      folderId: "0",
      createDate: this.tick(),
      modifyDate: this.tick(),
      content,
      extraInfo: JSON.stringify({ title }),
      ...extra,
    };
    this.notes.set(id, entry);
    return entry;
  }

  touch(id: string): void {
    this.notes.get(id)!.modifyDate = this.tick();
  }

  private tick(): number {
    this.clock += 1000;
    return this.clock;
  }

  async getAllNotes() {
    return {
      entries: [...this.notes.values()].map((n) => ({ ...n })),
      folders: { ...this.folders },
      syncTag: "",
    };
  }

  async getNote(id: string | number): Promise<RawNoteEntry> {
    this.getNoteCalls.push(String(id));
    const n = this.notes.get(String(id));
    if (!n) throw new Error(`not found: ${id}`);
    return structuredClone(n);
  }

  async createNote(entry: WriteNoteEntry): Promise<RawNoteEntry> {
    this.creates.push(entry);
    const id = String(this.nextId++);
    const created: RawNoteEntry = { ...entry, id, tag: `tag-${id}-1`, status: "normal" };
    this.notes.set(id, created);
    return created;
  }

  async updateNote(id: string, entry: WriteNoteEntry): Promise<RawNoteEntry> {
    this.updates.push({ id, entry });
    const updated: RawNoteEntry = { ...this.notes.get(id), ...entry, id, modifyDate: this.tick() };
    this.notes.set(id, updated);
    return updated;
  }

  async deleteNote(id: string, tag?: string, purge = false): Promise<void> {
    this.deletes.push({ id, tag, purge });
    this.notes.delete(id);
  }

  async createFolder(subject: string): Promise<RawFolderEntry> {
    this.createdFolders.push(subject);
    const folder: RawFolderEntry = { id: String(this.nextId++), subject, type: "folder" };
    this.folders[String(folder.id)] = folder;
    return folder;
  }

  async downloadFile(): Promise<boolean> {
    return !this.failDownloads;
  }

  async uploadImage(_buffer: Uint8Array, params: { filename: string; mimeType: string }) {
    this.uploads.push(params.filename);
    return { fileId: `up.${params.filename}`, digest: `d-${params.filename}` };
  }
}

async function sync(client: FakeClient, mode: SyncMode) {
  const { plan, state, folders } = await buildSyncPlan(client, outputDir, mode, true);
  return executeSyncPlan(client, outputDir, mode, plan, state, folders, { quiet: true });
}

async function listMd(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((f) => f.endsWith(".md")).sort();
}

test("sync: 同名笔记下行到不同文件，互不覆盖", async () => {
  const client = new FakeClient();
  client.add("1", "购物清单", '<text indent="1">牛奶</text>');
  client.add("2", "购物清单", '<text indent="1">鸡蛋</text>');

  const result = await sync(client, "cloud-first");
  assert.equal(result.errors.length, 0);
  assert.deepEqual(await listMd(outputDir), ["购物清单.md", "购物清单_2.md"]);

  const state = await loadState(outputDir);
  assert.notEqual(state.notes["1"].filePath, state.notes["2"].filePath);

  // 再同步一次不应产生任何动作（尤其不能把一条的内容当成另一条的本地修改上传）
  const again = await buildSyncPlan(client, outputDir, "two-way", true);
  assert.equal(again.plan.length, 0);
});

test("sync: 在 export 产物上首次同步时认领已有文件，不重复上传", async () => {
  const client = new FakeClient();
  client.add("1", "周报", '<text indent="1">本周进展</text>');
  client.add("2", "想法", '<text indent="1">一个点子</text>');
  await exportNotes(client, outputDir, false, true, cachePath);

  const { plan, state, stateChanged } = await buildSyncPlan(client, outputDir, "two-way", true);
  assert.equal(plan.length, 0, "内容一致的文件应被认领为已同步");
  assert.equal(stateChanged, true);
  assert.equal(state.notes["1"].filePath, "周报.md");
  assert.equal(client.creates.length, 0);
});

test("sync: 认领时内容不一致按冲突处理，非交互不改动任何数据", async () => {
  const client = new FakeClient();
  client.add("1", "周报", '<text indent="1">本周进展</text>');
  await exportNotes(client, outputDir, false, true, cachePath);
  await writeFile(join(outputDir, "周报.md"), "本周进展\n\n本地补充", "utf-8");

  const result = await sync(client, "two-way");
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].scenario, "both-changed");
  assert.equal(client.creates.length + client.updates.length, 0);
  assert.equal(await readFile(join(outputDir, "周报.md"), "utf-8"), "本周进展\n\n本地补充");
});

test("sync: 本地编辑带图笔记后上行，云端图片保留", async () => {
  const client = new FakeClient();
  client.add(
    "1",
    "旅行",
    `<text indent="1">出发</text>\n<img fileid="${IMAGE_ID}" imgshow="0" imgdes="" />`,
    { setting: { data: [{ fileId: IMAGE_ID, mimeType: "image/jpeg" }] } },
  );
  await sync(client, "cloud-first");

  const file = join(outputDir, "旅行.md");
  await writeFile(file, (await readFile(file, "utf-8")) + "\n\n到达", "utf-8");
  const result = await sync(client, "two-way");

  assert.equal(result.errors.length, 0);
  assert.equal(client.updates.length, 1);
  const xml = client.updates[0].entry.content;
  assert.match(xml, new RegExp(`<img fileid="${IMAGE_ID.replace(".", "\\.")}"`));
  assert.doesNotMatch(xml, /assets\//);
});

test("sync: 引用未上传的本地图片时拒绝上行并在结果中报告", async () => {
  const client = new FakeClient();
  client.add("1", "旅行", '<text indent="1">出发</text>');
  await sync(client, "cloud-first");

  await writeFile(join(outputDir, "旅行.md"), "出发\n\n![](./photo.png)", "utf-8");
  const result = await sync(client, "two-way");

  assert.equal(client.updates.length, 0);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].action, "update-remote");
  assert.match(result.errors[0].error, /photo\.png/);
});

test("sync: 本地删除文件后云端只移到回收站", async () => {
  const client = new FakeClient();
  client.add("1", "待办", '<text indent="1">买菜</text>');
  await sync(client, "cloud-first");

  await rm(join(outputDir, "待办.md"));
  await sync(client, "two-way");

  assert.deepEqual(client.deletes, [{ id: "1", tag: "tag-1-1", purge: false }]);
});

test("sync: 子目录中的本地新文件建到同名云端文件夹，缺失时自动创建", async () => {
  const client = new FakeClient();
  client.folders["f1"] = { id: "f1", subject: "工作", type: "folder" };
  await mkdir(join(outputDir, "工作"), { recursive: true });
  await mkdir(join(outputDir, "生活"), { recursive: true });
  await writeFile(join(outputDir, "工作", "a.md"), "会议纪要", "utf-8");
  await writeFile(join(outputDir, "生活", "b.md"), "菜谱", "utf-8");

  const result = await sync(client, "two-way");
  assert.equal(result.errors.length, 0);

  const byContent = (text: string) =>
    client.creates.find((e) => e.content.includes(text))!;
  assert.equal(byContent("会议纪要").folderId, "f1");
  assert.deepEqual(client.createdFolders, ["生活"]);
  assert.equal(byContent("菜谱").folderId, String(Object.values(client.folders).find((f) => f.subject === "生活")!.id));
});

test("sync: 生成计划后云端又被修改时放弃上行", async () => {
  const client = new FakeClient();
  client.add("1", "草稿", '<text indent="1">v1</text>');
  await sync(client, "cloud-first");
  await writeFile(join(outputDir, "草稿.md"), "v1 本地改", "utf-8");

  const { plan, state, folders } = await buildSyncPlan(client, outputDir, "two-way", true);
  assert.equal(plan[0].action, "update-remote");
  client.touch("1"); // 模拟另一台设备在此期间改了云端
  const result = await executeSyncPlan(client, outputDir, "two-way", plan, state, folders, { quiet: true });

  assert.equal(client.updates.length, 0);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].error, /云端/);
});

test("sync: 生成计划后本地文件又被修改时不覆盖本地", async () => {
  const client = new FakeClient();
  client.add("1", "草稿", '<text indent="1">v1</text>');
  await sync(client, "cloud-first");
  client.notes.get("1")!.content = '<text indent="1">v2</text>';
  client.touch("1");

  const { plan, state, folders } = await buildSyncPlan(client, outputDir, "two-way", true);
  assert.equal(plan[0].action, "update-local");
  await writeFile(join(outputDir, "草稿.md"), "用户刚写的", "utf-8");
  const result = await executeSyncPlan(client, outputDir, "two-way", plan, state, folders, { quiet: true });

  assert.equal(result.errors.length, 1);
  assert.equal(await readFile(join(outputDir, "草稿.md"), "utf-8"), "用户刚写的");
});

test("sync: 修复旧版本同名笔记共用一个文件的状态", async () => {
  const client = new FakeClient();
  const a = client.add("A", "日记", '<text indent="1">A 的内容</text>');
  const b = client.add("B", "日记", '<text indent="1">B 的内容</text>');
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, "日记.md"), "B 的内容", "utf-8");
  const hashB = computeHash("B 的内容");
  await saveState(outputDir, {
    lastSync: 1,
    folders: {},
    notes: {
      A: { id: "A", subject: "日记", filePath: "日记.md", baseHash: computeHash("A 的内容"), localHash: computeHash("A 的内容"), remoteModify: a.modifyDate },
      B: { id: "B", subject: "日记", filePath: "日记.md", baseHash: hashB, localHash: hashB, remoteModify: b.modifyDate },
    },
  });

  const result = await sync(client, "two-way");

  assert.equal(client.updates.length, 0, "不能把 B 的内容上传覆盖 A");
  assert.equal(result.applied["create-local"], 1);
  assert.equal(await readFile(join(outputDir, "日记.md"), "utf-8"), "B 的内容");
  assert.equal(await readFile(join(outputDir, "日记_A.md"), "utf-8"), "A 的内容");
});

test("sync: local-first 下云端已删本地已改 → 云端重建，旧记录移除", async () => {
  const client = new FakeClient();
  client.add("1", "计划", '<text indent="1">原文</text>');
  await sync(client, "cloud-first");
  client.notes.delete("1");
  await writeFile(join(outputDir, "计划.md"), "原文\n\n补充", "utf-8");

  const result = await sync(client, "local-first");
  assert.equal(result.errors.length, 0);
  assert.equal(client.creates.length, 1);

  const state = await loadState(outputDir);
  assert.equal(state.notes["1"], undefined);
  const ids = Object.keys(state.notes);
  assert.equal(ids.length, 1);
  assert.equal(state.notes[ids[0]].filePath, "计划.md");
});

test("export: 同名笔记确定性去重，创建最早的保留原名", async () => {
  const client = new FakeClient();
  client.add("20", "会议", '<text indent="1">第一次</text>', { createDate: 1 });
  client.add("10", "会议", '<text indent="1">第二次</text>', { createDate: 2 });

  const result = await exportNotes(client, outputDir, false, true, cachePath);
  assert.equal(result.written, 2);
  assert.equal(await readFile(join(outputDir, "会议.md"), "utf-8"), "第一次");
  assert.equal(await readFile(join(outputDir, "会议_10.md"), "utf-8"), "第二次");
});

test("export: 单条失败记入 errors，其余照常导出", async () => {
  const client = new FakeClient();
  client.add("1", "好的", '<text indent="1">ok</text>');
  client.add("2", "坏的", '<text indent="1">boom</text>');
  const getNote = client.getNote.bind(client);
  client.getNote = async (id) => {
    if (String(id) === "2") throw new Error("网络错误");
    return getNote(id);
  };

  const result = await exportNotes(client, outputDir, false, true, cachePath);
  assert.equal(result.written, 1);
  assert.deepEqual(result.errors, [{ id: "2", error: "网络错误" }]);
  assert.equal(await fileExists(join(outputDir, "好的.md")), true);
});

test("sync: 子目录笔记的附件引用写成 ../assets/，旧版 assets/ 写法认领时不报冲突", async () => {
  const client = new FakeClient();
  client.folders["f1"] = { id: "f1", subject: "旅行", type: "folder" };
  const note = client.add(
    "1",
    "京都",
    `<img fileid="${IMAGE_ID}" imgshow="0" imgdes="" />`,
    { folderId: "f1", setting: { data: [{ fileId: IMAGE_ID, mimeType: "image/jpeg" }] } },
  );
  const { files } = (await import("../src/converter.ts")).parseNoteEntry(note);
  const name = files[0].name;

  // 旧版本导出的文件：子目录里写的是 assets/
  await mkdir(join(outputDir, "旅行"), { recursive: true });
  await writeFile(join(outputDir, "旅行", "京都.md"), `![${name}](assets/${name})`, "utf-8");

  const { plan } = await buildSyncPlan(client, outputDir, "two-way", true);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].scenario, "remote-changed");
  const result = await sync(client, "two-way");
  assert.equal(result.errors.length, 0);
  assert.equal(
    await readFile(join(outputDir, "旅行", "京都.md"), "utf-8"),
    `![${name}](../assets/${name})`,
  );
});

test("sync: 本地新增的图片自动上传并登记到笔记附件", async () => {
  const client = new FakeClient();
  client.add("1", "旅行", '<text indent="1">出发</text>');
  await sync(client, "cloud-first");

  await writeFile(join(outputDir, "pic.png"), "fake-png");
  await writeFile(join(outputDir, "旅行.md"), "出发\n\n![](./pic.png)", "utf-8");
  const result = await sync(client, "two-way");

  assert.equal(result.errors.length, 0);
  assert.deepEqual(client.uploads, ["pic.png"]);
  const { entry } = client.updates[0];
  assert.match(entry.content, /<img fileid="up\.pic\.png"/);
  assert.deepEqual(entry.setting?.data, [{ fileId: "up.pic.png", digest: "d-pic.png", mimeType: "image/png" }]);
});

test("sync: 附件无法回写时在上传前就中止，不留下无用的上传", async () => {
  const client = new FakeClient();
  client.add("1", "旅行", '<text indent="1">出发</text>');
  await sync(client, "cloud-first");

  await writeFile(join(outputDir, "pic.png"), "fake-png");
  await writeFile(join(outputDir, "旅行.md"), "![](./pic.png)\n\n[🔊 a.mp3](assets/a.mp3)", "utf-8");
  const result = await sync(client, "two-way");

  assert.equal(result.errors.length, 1);
  assert.deepEqual(client.uploads, []);
});

test("sync: 本地新文件以文件名为云端标题", async () => {
  const client = new FakeClient();
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, "读书笔记.md"), "# 第一章\n\n正文", "utf-8");
  await sync(client, "two-way");

  assert.equal(JSON.parse(client.creates[0].extraInfo!).title, "读书笔记");
});

test("sync: 云端文件夹改名后，旧目录里的新文件仍建到原文件夹", async () => {
  const client = new FakeClient();
  client.folders["f1"] = { id: "f1", subject: "工作", type: "folder" };
  client.add("1", "周报", '<text indent="1">进展</text>', { folderId: "f1" });
  await sync(client, "cloud-first");

  client.folders["f1"].subject = "工作归档"; // 云端改名，笔记本身没变，本地目录仍叫「工作」
  await writeFile(join(outputDir, "工作", "新想法.md"), "点子", "utf-8");
  await sync(client, "two-way");

  assert.deepEqual(client.createdFolders, []);
  assert.equal(client.creates[0].folderId, "f1");
});

test("sync: 附件下载失败时正文照常同步，失败在结果中报告", async () => {
  const client = new FakeClient();
  client.add("1", "旅行", `<img fileid="${IMAGE_ID}" imgshow="0" imgdes="" />`, {
    setting: { data: [{ fileId: IMAGE_ID, mimeType: "image/jpeg" }] },
  });
  client.failDownloads = true;
  const result = await sync(client, "cloud-first");
  assert.equal(result.applied["create-local"], 1);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].error, /附件下载失败/);
  assert.equal(await fileExists(join(outputDir, "旅行.md")), true);
});

test("export: 增量跳过未变笔记，云端修改、本地改动、文件夹改名时重新拉取", async () => {
  const client = new FakeClient();
  client.folders["f1"] = { id: "f1", subject: "工作", type: "folder" };
  client.add("1", "周报", '<text indent="1">v1</text>', { folderId: "f1" });
  client.add("2", "想法", '<text indent="1">点子</text>');
  await exportNotes(client, outputDir, false, true, cachePath);

  client.getNoteCalls = [];
  const second = await exportNotes(client, outputDir, false, true, cachePath);
  assert.deepEqual(client.getNoteCalls, [], "未变的笔记不应再拉详情");
  assert.equal(second.skipped, 2);

  client.notes.get("1")!.content = '<text indent="1">v2</text>';
  client.touch("1");
  await writeFile(join(outputDir, "想法.md"), "本地乱改", "utf-8");
  client.getNoteCalls = [];
  await exportNotes(client, outputDir, false, true, cachePath);
  assert.deepEqual(client.getNoteCalls.sort(), ["1", "2"]);
  assert.equal(await readFile(join(outputDir, "工作", "周报.md"), "utf-8"), "v2");
  assert.equal(await readFile(join(outputDir, "想法.md"), "utf-8"), "点子");

  client.folders["f1"].subject = "归档";
  client.getNoteCalls = [];
  await exportNotes(client, outputDir, false, true, cachePath);
  assert.deepEqual(client.getNoteCalls, ["1"]);
  assert.equal(await readFile(join(outputDir, "归档", "周报.md"), "utf-8"), "v2");

  client.getNoteCalls = [];
  await exportNotes(client, outputDir, true, true, cachePath);
  assert.deepEqual(client.getNoteCalls.sort(), ["1", "2"], "--force 忽略缓存");
});

test("export: 附件下载失败的笔记不进缓存，下次重试", async () => {
  const client = new FakeClient();
  client.add("1", "旅行", `<img fileid="${IMAGE_ID}" imgshow="0" imgdes="" />`, {
    setting: { data: [{ fileId: IMAGE_ID, mimeType: "image/jpeg" }] },
  });
  client.failDownloads = true;
  const first = await exportNotes(client, outputDir, false, true, cachePath);
  assert.equal(first.errors.length, 1);

  client.failDownloads = false;
  client.getNoteCalls = [];
  const second = await exportNotes(client, outputDir, false, true, cachePath);
  assert.deepEqual(client.getNoteCalls, ["1"]);
  assert.equal(second.errors.length, 0);
});

test("export: 同名笔记减少后，旧的去重文件名文件被清理", async () => {
  const client = new FakeClient();
  client.add("20", "会议", '<text indent="1">第一次</text>', { createDate: 1 });
  client.add("10", "会议", '<text indent="1">第二次</text>', { createDate: 2 });
  await exportNotes(client, outputDir, false, true, cachePath);
  assert.deepEqual(await listMd(outputDir), ["会议.md", "会议_10.md"]);

  client.notes.delete("20");
  await exportNotes(client, outputDir, false, true, cachePath);
  assert.deepEqual(await listMd(outputDir), ["会议.md"]);
  assert.equal(await readFile(join(outputDir, "会议.md"), "utf-8"), "第二次");
});
