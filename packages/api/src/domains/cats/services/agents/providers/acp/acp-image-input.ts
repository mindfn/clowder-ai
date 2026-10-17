import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { MessageContent } from '@cat-cafe/shared';
import { detectImageMime } from '../../../../../../utils/image-mime.js';
import { MAX_IMAGE_FILE_SIZE } from '../../../../../../utils/image-storage.js';
import { getDefaultConnectorMediaDir, getDefaultUploadDir } from '../../../../../../utils/upload-paths.js';
import { AcpImageInputError, requireAcpImageCapability } from './acp-prompt-content.js';
import type { AcpContentBlock, AcpPromptCapabilities } from './types.js';

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};
const MAX_IMAGES = 5; // Same image-count ceiling as multipart message admission.
const invalid = () =>
  new AcpImageInputError('image_input_invalid', '图片附件路径或格式无效，请重新上传 PNG/JPEG/GIF/WebP 图片。');
const tooLarge = () =>
  new AcpImageInputError('image_input_too_large', '图片附件超过大小或数量限制，请减少附件后重试。');
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}

/** Only platform-owned image routes are dereferenced; no remote fetch or arbitrary native paths. */
export async function readAcpImageBlocks(
  content: readonly MessageContent[] | undefined,
  capabilities?: AcpPromptCapabilities,
  signal?: AbortSignal,
  uploadDir?: string,
): Promise<readonly AcpContentBlock[]> {
  const images = content?.filter((block) => block.type === 'image') ?? [];
  if (images.length === 0) return [];
  requireAcpImageCapability(capabilities);
  if (images.length > MAX_IMAGES) throw tooLarge();
  const blocks: AcpContentBlock[] = [];
  for (const image of images) {
    signal?.throwIfAborted();
    if (typeof image.url !== 'string') throw invalid();
    let selectedRoot: string;
    let encodedPath: string;
    if (image.url.startsWith('/uploads/')) {
      selectedRoot = getDefaultUploadDir(uploadDir ?? process.env.UPLOAD_DIR);
      encodedPath = image.url.slice('/uploads/'.length);
    } else if (image.url.startsWith('/api/connector-media/')) {
      selectedRoot = getDefaultConnectorMediaDir(process.env.CONNECTOR_MEDIA_DIR);
      encodedPath = image.url.slice('/api/connector-media/'.length);
    } else {
      throw invalid();
    }
    let root: string;
    try {
      root = await realpath(selectedRoot);
    } catch {
      throw new AcpImageInputError('image_input_unavailable', '图片附件无法读取，请重新上传。');
    }
    let path: string;
    try {
      path = resolve(root, decodeURIComponent(encodedPath));
    } catch {
      throw invalid();
    }
    if (!MIME_TYPES[extname(path).toLowerCase()] || !inside(root, path)) throw invalid();
    try {
      const canonical = await realpath(path);
      if (!inside(root, canonical)) throw invalid();
      const file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await file.stat();
        if (!info.isFile()) throw invalid();
        if (info.size > MAX_IMAGE_FILE_SIZE) throw tooLarge();
        // Bounded even when a file grows after stat; never silently truncate it.
        const buffer = Buffer.alloc(MAX_IMAGE_FILE_SIZE + 1);
        let length = 0;
        while (length < buffer.length) {
          signal?.throwIfAborted();
          const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
          if (bytesRead === 0) break;
          length += bytesRead;
        }
        if (length > MAX_IMAGE_FILE_SIZE) throw tooLarge();
        const bytes = buffer.subarray(0, length);
        const mimeType = detectImageMime(bytes);
        if (!mimeType) throw invalid();
        blocks.push(Object.freeze({ type: 'image', mimeType, data: bytes.toString('base64') }));
      } finally {
        await file.close();
      }
    } catch (error) {
      if (error instanceof AcpImageInputError || signal?.aborted) throw error;
      throw new AcpImageInputError('image_input_unavailable', '图片附件无法读取，请重新上传。');
    }
  }
  return Object.freeze(blocks);
}

export function withAcpImages(text: string, images: readonly AcpContentBlock[]): string | readonly AcpContentBlock[] {
  return images.length === 0 ? text : [{ type: 'text', text }, ...images];
}
