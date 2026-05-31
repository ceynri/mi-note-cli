// ============ 小米云笔记 API 原始数据结构 ============

/** 笔记附件原始数据 */
export interface RawNoteFile {
  rawId?: string;
  fileId?: string;
  digest?: string;
  mimeType?: string;
}

/** 笔记 setting 字段 */
export interface NoteSetting {
  themeId?: number;
  stickyTime?: number;
  version?: number;
  data?: RawNoteFile[];
}

export type NoteStatus = "normal" | "deleted";

/** 笔记 API 返回的原始条目 */
export interface RawNoteEntry {
  id: number | string;
  tag?: string;
  status?: NoteStatus;
  folderId?: number | string;
  subject?: string;
  content?: string;
  snippet?: string;
  createDate?: number;
  modifyDate?: number;
  colorId?: number;
  type?: string;
  alertDate?: number;
  alertTag?: number;
  extraInfo?: string | Record<string, unknown>;
  setting?: NoteSetting;
  files?: RawNoteFile[];
}

/** 写入笔记时的 entry 结构 */
export interface WriteNoteEntry {
  id?: string;
  tag?: string;
  status?: NoteStatus;
  createDate: number;
  modifyDate: number;
  colorId: number;
  content: string;
  setting?: NoteSetting;
  folderId: string;
  alertDate?: number;
  extraInfo?: string;
  subject?: string;
  snippet?: string;
}

/** 文件夹信息 */
export interface RawFolderEntry {
  id: number | string;
  tag?: string;
  status?: NoteStatus;
  subject?: string;
  folderId?: number | string;
  createDate?: number;
  modifyDate?: number;
  colorId?: number;
  type?: string;
  setting?: {
    themeId?: number;
    stickyTime?: number;
    version?: number;
  };
}

/** 写入文件夹时的 entry 结构 */
export interface WriteFolderEntry {
  id?: string;
  tag?: string;
  status?: NoteStatus;
  createDate: number;
  modifyDate: number;
  colorId?: number;
  type?: "folder";
  folderId?: string;
  subject: string;
  snippet?: string;
  setting?: {
    themeId?: number;
    stickyTime?: number;
    version?: number;
  };
  alertDate?: number;
  alertTag?: number;
}

// ============ API 响应封装 ============

export interface ApiEnvelope<T> {
  code: number;
  result: string;
  retriable?: boolean;
  description?: string;
  ts?: number;
  data: T;
}

export interface FullPageData {
  entries?: RawNoteEntry[];
  folders?: RawFolderEntry[];
  lastPage?: boolean;
  syncTag?: string;
}

export type FullPageResponse = ApiEnvelope<FullPageData>;
export type NoteDetailResponse = ApiEnvelope<{ entry: RawNoteEntry }>;
export type FolderDetailResponse = ApiEnvelope<{ entry: RawFolderEntry }>;
export type CreateNoteResponse = ApiEnvelope<{ entry: RawNoteEntry }>;
export type CreateFolderResponse = ApiEnvelope<{ entry: RawFolderEntry }>;
export type DeleteResponse = ApiEnvelope<{ id?: string; tag?: string; conflict?: boolean }>;

// ============ 图片上传相关 ============

/**
 * 请求上传凭证的响应。两种形态：
 * - 秒传：`data` 直接含 `{ digest, fileId }`（文件已存在服务端，无需上传）
 * - 新上传：`data.storage` 含分块上传所需的 `{ uploadId, exists, kss }`
 */
export interface RequestUploadResponse
  extends ApiEnvelope<{
    // 秒传形态
    digest?: string;
    fileId?: string;
    mimeType?: string;
    // 新上传形态
    storage?: {
      uploadId: string;
      exists: boolean;
      kss: {
        stat?: string;
        block_metas: Array<{ block_meta: string; is_existed?: number }>;
        node_urls: string[];
        file_meta: string;
        contentCacheKey?: string;
      };
    };
  }> {}

export interface CommitUploadPayload {
  storage: {
    uploadId: string;
    size: number;
    sha1: string;
    kss: {
      file_meta: string;
      commit_metas: Array<{ commit_meta: string }>;
    };
  };
}

export type CommitUploadResponse = ApiEnvelope<{ digest: string; fileId: string }>;

// ============ 解析后的领域模型 ============

/** 解析后的笔记附件信息 */
export interface NoteFile {
  rawId: string;
  name: string;
  id: string;
  type: string;
  suffix: string;
  fileId: string;
}

/** 解析后的笔记 */
export interface ParsedNote {
  id: string;
  folderId: string;
  subject: string;
  content: string;
  files: NoteFile[];
  createDate?: number;
  modifyDate?: number;
  contentType: string;
}

/** 列表项（精简展示用） */
export interface NoteListItem {
  id: string;
  title: string;
  snippet: string;
  modifyDate?: number;
  folderId: string;
}

// ============ 配置与认证 ============

/** 从 cookie 解析出的认证信息 */
export interface AuthInfo {
  cookie: string;
  serviceToken: string;
  userId: string;
}

// ============ 同步状态与配置 ============

/** 同步模式 */
export type SyncMode = "download" | "mirror" | "upload" | "two-way" | "manual";

/**
 * 单条笔记的同步基线记录（支撑 3-way diff）。
 * - baseHash：上次同步成功时的内容哈希（base，三方对比的基准）
 * - localHash：上次同步时本地文件内容哈希（用于判断本地是否被改动）
 * - remoteModify：上次同步时云端的 modifyDate
 *
 * filePath 存相对项目根（配置文件所在目录）的相对路径，
 * 因内容哈希本就跨机一致，相对路径让整个配置文件可随项目共享。
 */
export interface SyncNoteState {
  id: string;
  subject: string;
  filePath: string | null;
  baseHash?: string;
  localHash?: string;
  remoteModify?: number;
  /** 空笔记（无标题无内容），跳过导出但记录避免反复拉取 */
  empty?: boolean;
}

/**
 * 项目本地配置文件结构（项目根 `.mi-note-cli.json`）。
 *
 * 配置随项目走而非全局：一台机器可有多个项目各自同步，
 * mode 等策略可随项目提交、在多人协作中共享。
 * - output：同步目录，相对项目根的相对路径
 * - mode：同步模式（缺省时回落到 manual）
 * - notes/folders：同步基线状态，filePath 用相对路径，跨机一致
 */
export interface AppConfig {
  output?: string;
  mode?: SyncMode;
  lastSync?: number | null;
  syncTag?: string;
  notes: Record<string, SyncNoteState>;
  folders: Record<string, RawFolderEntry>;
}
