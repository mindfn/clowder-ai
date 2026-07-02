/**
 * Weixin-MP invoke handlers — platform-specific logic for commands
 * that cannot be expressed as pure REST calls in YAML.
 */
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import type { InvokeContext, InvokeHandler } from '../../domains/limb/PluginLimbAdapter.js';
import { fetchExternalUrlPinned } from '../../utils/url-safety.js';
import { markdownToWxHtml } from './markdown-to-wx-html.js';

const TIMEOUT_MS = 30_000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const BASE = 'https://api.weixin.qq.com/cgi-bin';

const EXTENSION_MIME_MAP: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  bmp: 'image/bmp',
};

interface WeixinMpHandlerDeps {
  fetchExternalUrlPinned?: typeof fetchExternalUrlPinned;
  uploadFormData?: typeof uploadFormData;
  readLocalFile?: (filePath: string) => Promise<Buffer>;
  jsonPost?: (url: string, body: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

// ─── Utilities ──────────────────────────────────────────────

function deriveImageMeta(contentType: string, baseName = 'image'): { mimeType: string; fileName: string } {
  const mimeType = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (!mimeType.startsWith('image/')) {
    throw new Error(`Expected image content-type, got: ${contentType}`);
  }
  const subtype = mimeType.slice('image/'.length);
  const ext = subtype === 'jpeg' ? 'jpg' : subtype.split('+', 1)[0];
  const safeExt = /^[a-z0-9]+$/.test(ext) ? ext : 'img';
  return { mimeType, fileName: `${baseName}.${safeExt}` };
}

async function uploadFormData(url: string, blob: Blob, fileName: string): Promise<Record<string, unknown>> {
  const form = new FormData();
  form.append('media', blob, fileName);
  const res = await fetch(url, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Upload request failed: HTTP ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

class WeixinApiError extends Error {
  constructor(
    readonly errcode: number,
    readonly errmsg: string,
  ) {
    super(`WeChat API error: ${errcode} ${errmsg}`);
    this.name = 'WeixinApiError';
  }
}

function checkWeixinResponse(data: Record<string, unknown>): void {
  const errcode = data.errcode;
  if (typeof errcode === 'number' && errcode !== 0) {
    throw new WeixinApiError(errcode, (data.errmsg as string | undefined) ?? '');
  }
}

/** Call WeChat API with automatic token-expired retry. */
async function withTokenRetry(
  ctx: InvokeContext,
  path: string,
  perform: (url: string) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const buildUrl = async () => {
    const token = await ctx.tokenManager.getAccessToken();
    const sep = path.includes('?') ? '&' : '?';
    return `${BASE}${path}${sep}access_token=${encodeURIComponent(token)}`;
  };
  const call = async () => {
    const data = await perform(await buildUrl());
    checkWeixinResponse(data);
    return data;
  };
  try {
    return await call();
  } catch (err) {
    if (err instanceof WeixinApiError && ctx.tokenManager.isTokenExpiredError(err.errcode)) {
      await ctx.tokenManager.invalidateAccessToken();
      return call();
    }
    throw err;
  }
}

function isHttpUrl(value: string): boolean {
  return value.startsWith('http://') || value.startsWith('https://');
}

/** Resolve image URI — HTTP(S) URL or local file path — into a Blob for WeChat upload. */
async function resolveImageSource(
  uri: string,
  deps: Required<WeixinMpHandlerDeps>,
  baseName = 'image',
): Promise<{ blob: Blob; fileName: string }> {
  if (isHttpUrl(uri)) {
    const imgRes = await deps.fetchExternalUrlPinned(uri, { timeoutMs: TIMEOUT_MS, maxBytes: MAX_IMAGE_BYTES });
    const meta = deriveImageMeta(imgRes.contentType, baseName);
    return { blob: new Blob([imgRes.body], { type: meta.mimeType }), fileName: meta.fileName };
  }
  const buffer = await deps.readLocalFile(uri);
  if (buffer.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`Image exceeds ${MAX_IMAGE_BYTES} bytes limit`);
  }
  const ext = extname(uri).slice(1).toLowerCase();
  const mimeType = EXTENSION_MIME_MAP[ext];
  if (!mimeType) throw new Error(`Unsupported image extension: .${ext}`);
  return {
    blob: new Blob([buffer], { type: mimeType }),
    fileName: `${baseName}.${ext === 'jpeg' ? 'jpg' : ext}`,
  };
}

/** Read text content from either an inline param or a local file path. */
async function resolveTextContent(
  inline: string | undefined,
  filePath: string | undefined,
  readFn: (fp: string) => Promise<Buffer>,
): Promise<string | undefined> {
  if (filePath) return (await readFn(filePath)).toString('utf-8');
  return inline;
}

// ─── Handlers ───────────────────────────────────────────────

export function createWeixinMpHandlers(deps: WeixinMpHandlerDeps = {}): Record<string, InvokeHandler> {
  const resolvedDeps: Required<WeixinMpHandlerDeps> = {
    fetchExternalUrlPinned,
    uploadFormData,
    readLocalFile: async (fp: string) => readFile(fp),
    jsonPost: async (url, body) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`Request failed: HTTP ${res.status}`);
      return (await res.json()) as Record<string, unknown>;
    },
    ...deps,
  };

  const convertMarkdown: InvokeHandler = async (params) => {
    const markdown = await resolveTextContent(
      params.markdown as string | undefined,
      params.markdownFilePath as string | undefined,
      resolvedDeps.readLocalFile,
    );
    if (!markdown) return { success: false, error: 'markdown or markdownFilePath is required' };
    const html = markdownToWxHtml(markdown);
    return { success: true, data: { html } };
  };

  const uploadImage: InvokeHandler = async (params, ctx) => {
    const uri = params.uri as string | undefined;
    if (!uri) return { success: false, error: 'uri is required' };
    const source = await resolveImageSource(uri, resolvedDeps);
    const data = await withTokenRetry(ctx, '/media/uploadimg', (url) =>
      resolvedDeps.uploadFormData(url, source.blob, source.fileName),
    );
    if (!data.url) throw new Error('Upload returned no url');
    return { success: true, data: { url: data.url } };
  };

  const uploadMaterial: InvokeHandler = async (params, ctx) => {
    const uri = params.uri as string | undefined;
    if (!uri) return { success: false, error: 'uri is required' };
    const source = await resolveImageSource(uri, resolvedDeps, 'cover');
    const data = await withTokenRetry(ctx, '/material/add_material?type=image', (url) =>
      resolvedDeps.uploadFormData(url, source.blob, source.fileName),
    );
    if (!data.media_id) throw new Error('Material upload returned no media_id');
    return { success: true, data: { mediaId: data.media_id, url: data.url ?? '' } };
  };

  const createDraft: InvokeHandler = async (params, ctx) => {
    const content = await resolveTextContent(
      params.content as string | undefined,
      params.contentFilePath as string | undefined,
      resolvedDeps.readLocalFile,
    );
    if (!content) return { success: false, error: 'content or contentFilePath is required' };
    const title = params.title as string;
    const thumbMediaId = params.thumbMediaId as string;
    if (!title || !thumbMediaId) {
      return { success: false, error: 'title and thumbMediaId are required' };
    }
    const body = {
      articles: [
        {
          title,
          content,
          thumb_media_id: thumbMediaId,
          show_cover_pic: 1,
          ...(params.author ? { author: params.author } : {}),
          ...(params.digest ? { digest: params.digest } : {}),
        },
      ],
    };
    const data = await withTokenRetry(ctx, '/draft/add', (url) => resolvedDeps.jsonPost(url, body));
    if (!data.media_id) throw new Error('Draft creation returned no media_id');
    return { success: true, data: { mediaId: data.media_id } };
  };

  const checkStatus: InvokeHandler = async (_params, ctx) => {
    const appId = ctx.pluginConfig.WEIXIN_MP_APP_ID;
    const appSecret = ctx.pluginConfig.WEIXIN_MP_APP_SECRET;
    if (!appId || !appSecret) {
      return { success: true, data: { status: 'not_configured' } };
    }
    try {
      await ctx.tokenManager.getAccessToken();
      return { success: true, data: { status: 'connected' } };
    } catch (e) {
      return {
        success: true,
        data: { status: 'error', message: e instanceof Error ? e.message : String(e) },
      };
    }
  };

  return {
    'weixin-mp:check_status': checkStatus,
    'weixin-mp:convert_markdown': convertMarkdown,
    'weixin-mp:create_draft': createDraft,
    'weixin-mp:upload_image': uploadImage,
    'weixin-mp:upload_material': uploadMaterial,
  };
}

// ─── Handler registry ───────────────────────────────────────

export const weixinMpHandlers: Record<string, InvokeHandler> = createWeixinMpHandlers();
