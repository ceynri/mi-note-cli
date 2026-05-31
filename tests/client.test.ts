import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MiNoteClient } from "../src/client.ts";
import type { AuthInfo, WriteNoteEntry } from "../src/types.ts";

const OLD_AUTH: AuthInfo = {
  cookie: "serviceToken=old; userId=u",
  serviceToken: "old",
  userId: "u",
};

const NEW_AUTH: AuthInfo = {
  cookie: "serviceToken=new; userId=u",
  serviceToken: "new",
  userId: "u",
};

function mockFetch(
  t: { after: (fn: () => void) => void },
  impl: typeof fetch,
): void {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  t.after(() => {
    globalThis.fetch = original;
  });
}

function noteEntry(): WriteNoteEntry {
  return {
    createDate: 1,
    modifyDate: 1,
    colorId: 0,
    content: "<note />",
    setting: { themeId: 0, stickyTime: 0, version: 0 },
    folderId: "0",
    alertDate: 0,
  };
}

test("MiNoteClient: GET 401 后静默续期并用新 cookie 重试", async (t) => {
  const cookies: string[] = [];
  let refreshCount = 0;
  mockFetch(t, (async (_input: RequestInfo | URL, init?: RequestInit) => {
    cookies.push(String((init?.headers as Record<string, string>).Cookie));
    if (cookies.length === 1) return new Response("expired", { status: 401 });
    return Response.json({
      result: "ok",
      data: { entries: [], folders: [], lastPage: true, syncTag: "s" },
    });
  }) as typeof fetch);

  const client = new MiNoteClient(OLD_AUTH, async () => {
    refreshCount++;
    return NEW_AUTH;
  });

  await client.getAllNotes();

  assert.deepEqual(cookies, [OLD_AUTH.cookie, NEW_AUTH.cookie]);
  assert.equal(refreshCount, 1);
});

test("MiNoteClient: POST 重试时重建 serviceToken", async (t) => {
  const bodies: string[] = [];
  mockFetch(t, (async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(String(init?.body));
    if (bodies.length === 1) return new Response("expired", { status: 401 });
    return Response.json({ result: "ok", data: { entry: { id: "1" } } });
  }) as typeof fetch);

  const client = new MiNoteClient(OLD_AUTH, async () => NEW_AUTH);
  await client.createNote(noteEntry());

  assert.match(bodies[0], /serviceToken=old/);
  assert.match(bodies[1], /serviceToken=new/);
});

test("MiNoteClient: refresher 失败时只重试一次并抛出登录态错误", async (t) => {
  let fetchCount = 0;
  let refreshCount = 0;
  mockFetch(t, (async () => {
    fetchCount++;
    return new Response("expired", { status: 401 });
  }) as typeof fetch);

  const client = new MiNoteClient(OLD_AUTH, async () => {
    refreshCount++;
    return null;
  });

  await assert.rejects(() => client.getAllNotes(), /登录态已过期/);
  assert.equal(fetchCount, 1);
  assert.equal(refreshCount, 1);
});

test("MiNoteClient: 附件下载也会续期后重试", async (t) => {
  const cookies: string[] = [];
  mockFetch(t, (async (_input: RequestInfo | URL, init?: RequestInit) => {
    cookies.push(String((init?.headers as Record<string, string>).Cookie));
    if (cookies.length === 1) return new Response("expired", { status: 401 });
    return new Response("image-data");
  }) as typeof fetch);

  const dir = await mkdtemp(join(tmpdir(), "mi-note-client-"));
  const path = join(dir, "image.txt");
  t.after(() => rm(dir, { recursive: true, force: true }));

  const client = new MiNoteClient(OLD_AUTH, async () => NEW_AUTH);
  assert.equal(await client.downloadFile("file-id", path), true);
  assert.deepEqual(cookies, [OLD_AUTH.cookie, NEW_AUTH.cookie]);
  assert.equal(await readFile(path, "utf-8"), "image-data");
});
