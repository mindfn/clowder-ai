import { resolve } from 'node:path';
import { resolveUploadsDir } from '../config/data-dirs.js';

/**
 * Resolve the upload directory.
 *
 * An explicit override (e.g. opts.uploadDir for tests / DI) wins. Otherwise
 * the unified resolver decides: DATA_DIR/uploads if DATA_DIR is set, else
 * the module-relative packages/api/uploads default (so API routes and
 * connector outbound delivery share the same on-disk truth source).
 */
export function getDefaultUploadDir(override?: string): string {
  return override ? resolve(override) : resolveUploadsDir();
}

const INTERNAL_ROUTE_PREFIXES = ['/uploads/', '/api/connector-media/', '/api/tts/audio/'];

export function resolveInternalRouteUrl(url: string): string {
  if (url.startsWith('https://') || url.startsWith('http://')) return url;
  if (INTERNAL_ROUTE_PREFIXES.some((p) => url.startsWith(p))) {
    const apiBase = (
      process.env.CAT_CAFE_API_URL ??
      process.env.NEXT_PUBLIC_API_URL ??
      'http://localhost:3004'
    ).replace(/\/$/, '');
    return `${apiBase}${url}`;
  }
  return url;
}
