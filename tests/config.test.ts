import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileExists } from "../src/utils.ts";
import {
  getProjectRoot,
  getUserConfigPath,
  getDefaultOutputDir,
  getStatePath,
  loadUserConfig,
  saveUserConfig,
  loadState,
  saveState,
  resolveOutputDir,
  resolveSyncMode,
  setSyncMode,
  setOutput,
  toOutputRel,
  toOutputAbs,
} from "../src/config.ts";
import type { SyncState } from "../src/types.ts";

/**
 * src/config.ts 纯逻辑单元测试。
 *
 * 通过 MI_NOTE_CLI_CONFIG_DIR 环境变量把项目根隔离到临时目录，
 * 不触碰真实工作区与用户配置。零网络依赖。
 */

let projectRoot: string;
let prevEnv: string | undefined;

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), "mi-note-cli-cfgtest-"));
  prevEnv = process.env.MI_NOTE_CLI_CONFIG_DIR;
  process.env.MI_NOTE_CLI_CONFIG_DIR = projectRoot;
});

afterEach(async () => {
  if (prevEnv === undefined) delete process.env.MI_NOTE_CLI_CONFIG_DIR;
  else process.env.MI_NOTE_CLI_CONFIG_DIR = prevEnv;
  await rm(projectRoot, { recursive: true, force: true });
});

// ============ 路径解析 ============

test("getProjectRoot 读取 MI_NOTE_CLI_CONFIG_DIR 环境变量", () => {
  assert.equal(getProjectRoot(), projectRoot);
});

test("getUserConfigPath 落在 <root>/.mi-note-cli/config.json", () => {
  assert.equal(
    getUserConfigPath(),
    join(projectRoot, ".mi-note-cli", "config.json"),
  );
});

test("getDefaultOutputDir 落在 <root>/.mi-note-cli/output", () => {
  assert.equal(
    getDefaultOutputDir(),
    join(projectRoot, ".mi-note-cli", "output"),
  );
});

test("getStatePath 在传入 output 目录内", () => {
  const out = join(projectRoot, "anywhere");
  assert.equal(getStatePath(out), join(out, ".mi-note-cli.state.json"));
});

test("toOutputRel / toOutputAbs 互逆", () => {
  const out = join(projectRoot, "out");
  const abs = join(out, "sub", "note.md");
  const rel = toOutputRel(abs, out);
  assert.equal(rel, join("sub", "note.md"));
  assert.equal(toOutputAbs(rel, out), abs);
});

test("toOutputAbs 接受绝对路径直接返回", () => {
  const out = join(projectRoot, "out");
  const abs = join(projectRoot, "elsewhere", "x.md");
  assert.equal(toOutputAbs(abs, out), abs);
});

// ============ UserConfig 读写 ============

test("loadUserConfig：文件不存在返回空配置", async () => {
  const cfg = await loadUserConfig();
  assert.equal(cfg.syncMode, undefined);
  assert.equal(cfg.output, undefined);
  assert.equal(cfg.fileNameTemplate, undefined);
});

test("loadUserConfig：JSON 解析失败时静默回落空对象（不抛错）", async () => {
  // 用 saveUserConfig 先建好父目录，再写入坏内容
  await saveUserConfig({});
  await writeFile(getUserConfigPath(), "{not valid json", "utf-8");
  const cfg = await loadUserConfig();
  assert.equal(cfg.syncMode, undefined);
  assert.equal(cfg.output, undefined);
  assert.equal(cfg.fileNameTemplate, undefined);
});

test("saveUserConfig → loadUserConfig 往返保留所有字段", async () => {
  await saveUserConfig({
    syncMode: "two-way",
    output: "./mi-notes",
    fileNameTemplate: "${YYYY}-${MM}-${DD}",
  });
  const cfg = await loadUserConfig();
  assert.equal(cfg.syncMode, "two-way");
  assert.equal(cfg.output, "./mi-notes");
  assert.equal(cfg.fileNameTemplate, "${YYYY}-${MM}-${DD}");
});

test("saveUserConfig 自动建出 .mi-note-cli/ 父目录", async () => {
  await saveUserConfig({ syncMode: "manual" });
  assert.ok(await fileExists(getUserConfigPath()), "config.json 应已落盘");
  const raw = await readFile(getUserConfigPath(), "utf-8");
  assert.match(raw, /"syncMode": "manual"/);
});

// ============ SyncState 读写 ============

test("loadState：文件不存在返回空 state（lastSync=null, notes/folders 空）", async () => {
  const state = await loadState(join(projectRoot, "outX"));
  assert.equal(state.lastSync, null);
  assert.deepEqual(state.notes, {});
  assert.deepEqual(state.folders, {});
});

test("saveState → loadState 往返保留 notes/folders", async () => {
  const out = join(projectRoot, "out1");
  const original: SyncState = {
    lastSync: 1717_000_000_000,
    syncTag: "abc",
    notes: {
      "100": {
        id: "100",
        subject: "测试",
        filePath: "测试.md",
        baseHash: "h1",
        localHash: "h1",
        remoteModify: 1717_000_000_000,
      },
    },
    folders: {},
  };
  await saveState(out, original);
  const loaded = await loadState(out);
  assert.equal(loaded.lastSync, original.lastSync);
  assert.equal(loaded.syncTag, "abc");
  assert.deepEqual(loaded.notes, original.notes);
});

test("saveState 写到 <output>/.mi-note-cli.state.json，不写到项目根", async () => {
  const out = join(projectRoot, "out2");
  await saveState(out, { lastSync: 1, notes: {}, folders: {} });
  assert.ok(
    await fileExists(join(out, ".mi-note-cli.state.json")),
    "state 文件应在 output 目录内",
  );
  assert.ok(
    !(await fileExists(join(projectRoot, ".mi-note-cli.state.json"))),
    "state 不应写到项目根",
  );
});

// ============ 优先级解析 ============

test("resolveOutputDir 优先级：CLI > UserConfig.output > 默认 .mi-note-cli/output/", async () => {
  // 1) 全空 → 默认（基于项目根）
  assert.equal(await resolveOutputDir(), getDefaultOutputDir());

  // 2) 只配 UserConfig.output（相对路径基于项目根，与配置文件同处）
  await saveUserConfig({ output: "./custom" });
  assert.equal(await resolveOutputDir(), join(projectRoot, "custom"));

  // 3) CLI 覆盖 UserConfig；CLI 相对路径基于 cwd（终端 pwd 直觉，符合 Unix 工具约定）
  assert.equal(
    await resolveOutputDir("./from-cli"),
    join(process.cwd(), "from-cli"),
  );
});

test("resolveOutputDir：CLI 绝对路径直接返回", async () => {
  const abs = join(projectRoot, "abs-cli");
  assert.equal(await resolveOutputDir(abs), abs);
});

test("resolveOutputDir：UserConfig 中绝对路径直接返回", async () => {
  const abs = join(projectRoot, "abs-out");
  await saveUserConfig({ output: abs });
  assert.equal(await resolveOutputDir(), abs);
});

test("resolveSyncMode 优先级：CLI > UserConfig.syncMode > 默认 manual", async () => {
  // 1) 全空 → manual
  assert.equal(await resolveSyncMode(), "manual");

  // 2) UserConfig
  await saveUserConfig({ syncMode: "two-way" });
  assert.equal(await resolveSyncMode(), "two-way");

  // 3) CLI 覆盖
  assert.equal(await resolveSyncMode("local-first"), "local-first");
});

// ============ setSyncMode / setOutput 写入 ============

test("setSyncMode 写入 UserConfig 且不影响其他字段", async () => {
  await saveUserConfig({ output: "./keep", fileNameTemplate: "${id}" });
  await setSyncMode("cloud-first");
  const cfg = await loadUserConfig();
  assert.equal(cfg.syncMode, "cloud-first");
  assert.equal(cfg.output, "./keep", "output 字段应保留");
  assert.equal(cfg.fileNameTemplate, "${id}", "template 应保留");
});

test("setOutput 写入 UserConfig 且不影响其他字段", async () => {
  await saveUserConfig({ syncMode: "cloud-first" });
  await setOutput("./new-out");
  const cfg = await loadUserConfig();
  assert.equal(cfg.output, "./new-out");
  assert.equal(cfg.syncMode, "cloud-first", "syncMode 字段应保留");
});
