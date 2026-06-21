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
  /** 用于落盘的标题（已 sanitize；缺标题时回退为内容首行 / 创建时间字符串） */
  subject: string;
  /**
   * 真实标题（未 sanitize）。仅取自 `extraInfo.title` 或笔记 `subject` 字段。
   * 用户没为笔记起标题时为空字符串——**不会**回退到内容首行或 datetime。
   *
   * 供文件名模板的 `${title}` 占位符使用，让用户能区分「真有标题」与「兜底称呼」。
   * 想要永有非空文件名请用 `${subject}`（见 `UserConfig.fileNameTemplate`）。
   */
  rawTitle: string;
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
export type SyncMode = "cloud-first" | "local-first" | "two-way" | "manual";

/**
 * 单条笔记的同步基线记录（支撑 3-way diff）。
 * - baseHash：上次同步成功时的内容哈希（base，三方对比的基准）
 * - localHash：上次同步时本地文件内容哈希（用于判断本地是否被改动）
 * - remoteModify：上次同步时云端的 modifyDate
 *
 * filePath 存「相对 output 目录」的相对路径——state 文件本身就在 output 内，
 * 整个 output 可整体搬迁仍能继续 sync（账号一致前提下）。跨机一致由内容 hash 保证。
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
 * 用户配置（项目根 `.mi-note-cli/config.json`）。
 *
 * 用户手写、可入版控、可团队共享。所有字段均可选；缺省时各命令使用内置默认值。
 * - syncMode：默认同步模式（缺省回落到 manual）
 * - output：默认同步/导出目录（CLI `-o` 优先；都缺省时落到 `<root>/.mi-note-cli/output/`）
 * - fileNameTemplate：见下方文档
 */
export interface UserConfig {
  syncMode?: SyncMode;
  output?: string;
  /**
   * 同步落盘文件名模板（不含 `.md` 后缀）。
   *
   * 支持占位符：
   * - `${YYYY}` `${YY}` `${MM}` `${DD}` `${HH}` `${mm}` `${ss}`：笔记 `createDate` 的本地时区分量
   * - `${title}`：真实标题，未填即空（适合搭配条件段语法）
   * - `${subject}`：带兜底的称呼（真实标题 → 内容首行 → datetime），永远非空
   * - `${id}`：笔记 id
   *
   * 条件段 `[...]`：方括号内全部 `${var}` 都非空才渲染，否则整块丢弃。用于把可选段
   * 连同其引导分隔符一起包起来，例如 `${YYYY}-${MM}-${DD}[_${title}]` 在无标题时
   * 自然得到 `2026-06-06`。字面 `[` `]` 用 `\[` `\]` 转义。
   *
   * 缺省（未设置）等价 `${subject}`：保持永有非空文件名。
   */
  fileNameTemplate?: string;
}

/**
 * 同步状态（output 目录内 `.mi-note-cli.state.json`）。
 *
 * 工具自动生成、与具体 output 目录 1:1 绑定、不入版控。换 output 各自独立。
 * - lastSync：上次同步时间戳
 * - syncTag：服务端增量同步 tag（保留字段，目前未使用）
 * - notes/folders：3-way diff 所需基线快照；notes[].filePath 相对 output
 */
export interface SyncState {
  /** 上次同步时间戳；从未同步时为 null。loadState 已规范化缺失值为 null，消费者无需判 undefined */
  lastSync: number | null;
  syncTag?: string;
  notes: Record<string, SyncNoteState>;
  folders: Record<string, RawFolderEntry>;
}
