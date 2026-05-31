import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { getClient } from "./shared.js";
import { inferImageMimeType } from "../utils.js";
import { success, logInfo, fail } from "../output.js";

interface UploadOptions {
  mime?: string;
  filename?: string;
}

/** 上传图片，返回可嵌入笔记的 fileId 与 Markdown 引用 */
export async function uploadImageCommand(
  path: string,
  opts: UploadOptions,
): Promise<void> {
  try {
    const buffer = await readFile(path);
    const filename = opts.filename ?? basename(path);
    const mimeType = opts.mime ?? inferImageMimeType(filename);

    const client = await getClient();
    const { fileId, digest } = await client.uploadImage(new Uint8Array(buffer), {
      filename,
      mimeType,
    });

    const markdown = `![图片](minote://image/${fileId})`;
    success({ fileId, digest, markdown }, () => {
      logInfo(`✅ 上传成功：fileId=${fileId}`);
      process.stdout.write(`${markdown}\n`);
      logInfo(
        "提示：把上面的 Markdown 放进 create/update 的内容里，即可在笔记中引用该图片。",
      );
    });
  } catch (err) {
    fail(err);
  }
}
