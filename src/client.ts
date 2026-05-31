import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { buildHeaders } from "./auth.js";
import { fileExists, ensureFileDir, delay, randomDelay } from "./utils.js";
import type {
  AuthInfo,
  RawNoteEntry,
  RawFolderEntry,
  FullPageData,
  FullPageResponse,
  NoteDetailResponse,
  FolderDetailResponse,
  CreateNoteResponse,
  CreateFolderResponse,
  DeleteResponse,
  WriteNoteEntry,
  WriteFolderEntry,
  RequestUploadResponse,
  CommitUploadPayload,
  CommitUploadResponse,
} from "./types.js";

const API_BASE = "https://i.mi.com";

/**
 * 小米云笔记 API 客户端：封装全部读/写/上传/下载操作。
 *
 * 写操作统一为 POST + application/x-www-form-urlencoded，body 携带 serviceToken。
 * 更新/删除遵循乐观锁：先 GET 拿最新 tag，再提交。
 */
export class MiNoteClient {
  constructor(private readonly auth: AuthInfo) {}

  private get cookie(): string {
    return this.auth.cookie;
  }

  // ============ 读操作 ============

  /** 获取笔记列表（单页） */
  private async fetchPage(
    limit = 200,
    syncTag = "",
  ): Promise<FullPageData> {
    const params = new URLSearchParams({
      ts: String(Date.now()),
      limit: String(limit),
    });
    if (syncTag) params.set("syncTag", syncTag);

    const url = `${API_BASE}/note/full/page/?${params}`;
    const json = await this.getJson<FullPageResponse>(url);
    if (json.result !== "ok" || !json.data) {
      throw new Error(`获取笔记列表失败: ${JSON.stringify(json)}`);
    }
    return json.data;
  }

  /**
   * 获取全部笔记（自动分页）。
   * @param onProgress 进度回调（已获取条数）
   */
  async getAllNotes(
    limit = 200,
    onProgress?: (count: number) => void,
  ): Promise<{
    entries: RawNoteEntry[];
    folders: Record<string, RawFolderEntry>;
    syncTag: string;
  }> {
    let syncTag = "";
    const allEntries: RawNoteEntry[] = [];
    const allFolders: Record<string, RawFolderEntry> = {};

    while (true) {
      const data = await this.fetchPage(limit, syncTag);
      const entries = data.entries ?? [];
      const folders = data.folders ?? [];
      allEntries.push(...entries);
      for (const folder of folders) {
        allFolders[String(folder.id)] = folder;
      }
      onProgress?.(allEntries.length);

      syncTag = data.syncTag ?? syncTag;
      if (data.lastPage) break;
      if (!syncTag) break;
      await randomDelay(300);
    }

    return { entries: allEntries, folders: allFolders, syncTag };
  }

  /** 获取笔记详情 */
  async getNote(noteId: string | number): Promise<RawNoteEntry> {
    const url = `${API_BASE}/note/note/${encodeURIComponent(String(noteId))}/?ts=${Date.now()}`;
    const json = await this.getJson<NoteDetailResponse>(url);
    if (json.result !== "ok" || !json.data?.entry) {
      throw new Error(`获取笔记详情失败: ${noteId}`);
    }
    return json.data.entry;
  }

  // ============ 写操作：笔记 ============

  /** 创建笔记 */
  async createNote(entry: WriteNoteEntry): Promise<RawNoteEntry> {
    const json = await this.postForm<CreateNoteResponse>("/note/note", {
      entry: JSON.stringify(entry),
      serviceToken: this.auth.serviceToken,
    });
    if (json.result !== "ok" || !json.data?.entry) {
      throw new Error(`创建笔记失败: ${json.description ?? JSON.stringify(json)}`);
    }
    return json.data.entry;
  }

  /** 更新笔记 */
  async updateNote(
    noteId: string,
    entry: WriteNoteEntry,
  ): Promise<RawNoteEntry> {
    const json = await this.postForm<NoteDetailResponse>(
      `/note/note/${encodeURIComponent(noteId)}`,
      {
        entry: JSON.stringify(entry),
        serviceToken: this.auth.serviceToken,
      },
    );
    if (json.result !== "ok") {
      throw new Error(`更新笔记失败: ${json.description ?? JSON.stringify(json)}`);
    }
    return json.data?.entry ?? entry as unknown as RawNoteEntry;
  }

  /** 删除笔记（默认移到回收站；purge=true 永久删除） */
  async deleteNote(
    noteId: string,
    tag?: string,
    purge = false,
  ): Promise<void> {
    let noteTag = tag;
    if (!noteTag) {
      const entry = await this.getNote(noteId);
      noteTag = entry.tag;
      if (!noteTag) throw new Error("笔记详情中未找到 tag，无法删除");
    }
    await this.deleteEntity(noteId, noteTag, purge);
  }

  // ============ 写操作：文件夹 ============

  /** 创建文件夹 */
  async createFolder(subject: string, parentId = "0"): Promise<RawFolderEntry> {
    const now = Date.now();
    const entry: WriteFolderEntry = {
      subject,
      folderId: parentId,
      createDate: now,
      modifyDate: now,
      colorId: 0,
      alertDate: 0,
      alertTag: 0,
      type: "folder",
      setting: { themeId: 0, stickyTime: 0, version: 0 },
    };
    const json = await this.postForm<CreateFolderResponse>("/note/folder", {
      entry: JSON.stringify(entry),
      serviceToken: this.auth.serviceToken,
    });
    if (json.result !== "ok" || !json.data?.entry) {
      throw new Error(`创建文件夹失败: ${json.description ?? JSON.stringify(json)}`);
    }
    return json.data.entry;
  }

  /** 更新文件夹（如重命名） */
  async updateFolder(
    folderId: string,
    folder: WriteFolderEntry,
  ): Promise<RawFolderEntry> {
    const json = await this.postForm<FolderDetailResponse>(
      `/note/folder/${encodeURIComponent(folderId)}`,
      {
        entry: JSON.stringify(folder),
        serviceToken: this.auth.serviceToken,
      },
    );
    if (json.result !== "ok") {
      throw new Error(`更新文件夹失败: ${json.description ?? JSON.stringify(json)}`);
    }
    return json.data?.entry ?? (folder as unknown as RawFolderEntry);
  }

  /** 删除文件夹（默认移到回收站；purge=true 永久删除） */
  async deleteFolder(
    folderId: string,
    tag: string,
    purge = false,
  ): Promise<void> {
    await this.deleteEntity(folderId, tag, purge);
  }

  /**
   * 删除实体（笔记或文件夹共用同一端点）。
   *
   * 小米删除是两步状态机：`normal --(purge=false)--> deleted --(purge=true)--> 物理删除`，
   * 不能跳步——对 normal 实体直接 purge 会返回「便签未被删除」(code 51006)。
   * 因此 purge=true 时内部自动先软删除拿到新 tag，再用新 tag 永久删除。
   * 每步删除都会让 tag 递增（乐观锁），故第二步必须用第一步返回的新 tag。
   */
  private async deleteEntity(
    id: string,
    tag: string,
    purge: boolean,
  ): Promise<void> {
    // 第一步：软删除（移到回收站）
    const soft = await this.postDelete(id, tag, false);
    if (!purge) return;

    // 第二步：用软删除返回的新 tag 永久删除
    const newTag = soft.data?.tag;
    if (!newTag) {
      throw new Error("软删除未返回新 tag，无法继续永久删除");
    }
    await this.postDelete(id, newTag, true);
  }

  /** 单次删除请求 */
  private async postDelete(
    id: string,
    tag: string,
    purge: boolean,
  ): Promise<DeleteResponse> {
    const json = await this.postForm<DeleteResponse>(
      `/note/full/${encodeURIComponent(id)}/delete`,
      {
        tag,
        purge: String(purge),
        serviceToken: this.auth.serviceToken,
      },
    );
    if (json.result !== "ok") {
      throw new Error(`删除失败: ${json.description ?? JSON.stringify(json)}`);
    }
    if (json.data?.conflict) {
      throw new Error("删除时发生冲突（tag 已过期），请重试");
    }
    return json;
  }

  // ============ 附件下载 ============

  /** 下载附件文件到本地（已存在则跳过） */
  async downloadFile(fileId: string, savePath: string): Promise<boolean> {
    if (await fileExists(savePath)) return true;

    const params = new URLSearchParams({
      type: "note_img",
      fileid: fileId,
      ts: String(Date.now()),
    });
    const url = `${API_BASE}/file/full?${params}`;

    const maxRetries = 2;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const resp = await fetch(url, {
          headers: buildHeaders(this.cookie),
          redirect: "follow",
        });
        if (!resp.ok) {
          if (attempt < maxRetries) {
            await delay(500 * (attempt + 1));
            continue;
          }
          return false;
        }
        const buffer = Buffer.from(await resp.arrayBuffer());
        await ensureFileDir(savePath);
        await writeFile(savePath, buffer);
        return true;
      } catch {
        if (attempt < maxRetries) {
          await delay(500 * (attempt + 1));
          continue;
        }
        return false;
      }
    }
    return false;
  }

  // ============ 图片上传（两阶段 + 秒传） ============

  /** 请求上传凭证 */
  private async requestUpload(meta: {
    filename: string;
    size: number;
    sha1: string;
    md5: string;
    mimeType: string;
  }): Promise<RequestUploadResponse> {
    const payload = {
      type: "note_img",
      storage: {
        filename: meta.filename,
        size: meta.size,
        sha1: meta.sha1,
        mimeType: meta.mimeType,
        kss: {
          block_infos: [
            { blob: {}, size: meta.size, md5: meta.md5, sha1: meta.sha1 },
          ],
        },
      },
    };
    const json = await this.postForm<RequestUploadResponse>(
      "/file/v2/user/request_upload_file",
      { data: JSON.stringify(payload), serviceToken: this.auth.serviceToken },
    );
    if (json.result !== "ok" || !json.data) {
      throw new Error(
        `请求上传凭证失败: ${json.description ?? JSON.stringify(json)}`,
      );
    }
    return json;
  }

  /** 提交上传 */
  private async commitUpload(
    payload: CommitUploadPayload,
  ): Promise<CommitUploadResponse> {
    const json = await this.postForm<CommitUploadResponse>(
      "/file/v2/user/commit",
      { commit: JSON.stringify(payload), serviceToken: this.auth.serviceToken },
    );
    if (json.result !== "ok" || !json.data?.fileId) {
      throw new Error(`提交上传失败: ${json.description ?? JSON.stringify(json)}`);
    }
    return json;
  }

  /**
   * 上传图片，返回 { fileId, digest }。
   * 流程：请求凭证 →（秒传则直接返回 fileId）→ 否则上传到 KSS 节点 → 提交。
   */
  async uploadImage(
    buffer: Uint8Array,
    params: { filename: string; mimeType: string },
  ): Promise<{ fileId: string; digest: string }> {
    const size = buffer.byteLength;
    const sha1 = createHash("sha1").update(buffer).digest("hex");
    const md5 = createHash("md5").update(buffer).digest("hex");

    const tokenResp = await this.requestUpload({
      filename: params.filename,
      size,
      sha1,
      md5,
      mimeType: params.mimeType,
    });

    // 秒传：服务端已有该文件，凭证响应直接含 fileId，无需上传与提交
    if (tokenResp.data.fileId) {
      return {
        fileId: tokenResp.data.fileId,
        digest: tokenResp.data.digest ?? "",
      };
    }

    const storage = tokenResp.data.storage;
    if (!storage) {
      throw new Error("上传凭证响应异常：既无 fileId 也无 storage");
    }
    const { uploadId, exists, kss } = storage;
    let commitMetas: { commit_meta: string }[] = [];

    if (!exists) {
      const nodeUrl = kss.node_urls?.[0];
      const blockMeta = kss.block_metas?.[0]?.block_meta;
      if (!nodeUrl || !blockMeta) {
        throw new Error("上传凭证缺少节点信息");
      }
      const uploadUrl = `${nodeUrl}/upload_block_chunk?chunk_pos=0&file_meta=${encodeURIComponent(
        kss.file_meta,
      )}&block_meta=${encodeURIComponent(blockMeta)}`;
      const uploadResp = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Blob([buffer as Uint8Array<ArrayBuffer>]),
      });
      if (!uploadResp.ok) {
        const text = await uploadResp.text();
        throw new Error(`上传图片数据失败 ${uploadResp.status}: ${text}`);
      }
      const metaBody = (await uploadResp.json()) as { commit_meta?: string };
      if (!metaBody?.commit_meta) {
        throw new Error("上传节点返回异常，缺少 commit_meta");
      }
      commitMetas = [{ commit_meta: metaBody.commit_meta }];
    }

    const commitPayload: CommitUploadPayload = {
      storage: {
        uploadId,
        size,
        sha1,
        kss: { file_meta: kss.file_meta, commit_metas: commitMetas },
      },
    };
    const committed = await this.commitUpload(commitPayload);
    return { fileId: committed.data.fileId, digest: committed.data.digest };
  }

  // ============ 底层请求 ============

  private async getJson<T>(url: string): Promise<T> {
    const resp = await fetch(url, { headers: buildHeaders(this.cookie) });
    if (resp.status === 401) {
      throw new Error("登录态已过期，请重新登录（mi-note-cli login）");
    }
    if (!resp.ok) {
      throw new Error(`请求失败 ${resp.status} ${resp.statusText}`);
    }
    return (await resp.json()) as T;
  }

  private async postForm<T>(
    path: string,
    params: Record<string, string>,
  ): Promise<T> {
    const body = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");
    const resp = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: {
        ...buildHeaders(this.cookie),
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      },
      body,
    });
    if (resp.status === 401) {
      throw new Error("登录态已过期，请重新登录（mi-note-cli login）");
    }
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`请求失败 ${resp.status}: ${text}`);
    }
    return (await resp.json()) as T;
  }
}
