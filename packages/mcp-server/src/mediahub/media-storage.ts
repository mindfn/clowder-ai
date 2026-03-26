/**
 * MediaHub — Media Storage
 * F139: Downloads generated media to local filesystem.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const DEFAULT_OUTPUT_DIR = 'data/mediahub/outputs';
const DOWNLOAD_TIMEOUT_MS = 120_000; // 2 min
const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024; // 500 MB
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

export class MediaStorage {
  private readonly baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? path.resolve(process.cwd(), DEFAULT_OUTPUT_DIR);
  }

  private ensureJobDir(providerId: string, jobId: string): string {
    const dir = path.join(this.baseDir, providerId, jobId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Download a media file from URL and save locally. Returns local file path. */
  async download(providerId: string, jobId: string, url: string, filename?: string): Promise<string> {
    // Validate URL protocol to prevent SSRF
    const parsed = new URL(url);
    if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
      throw new Error(`Blocked download: protocol "${parsed.protocol}" not allowed`);
    }

    const dir = this.ensureJobDir(providerId, jobId);
    const ext = this.guessExtension(url, filename);
    const outFile = filename ?? `output${ext}`;
    const filePath = path.join(dir, outFile);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`Download failed (${response.status}): ${url}`);
      }
      if (!response.body) {
        throw new Error('Download returned empty body');
      }

      // Check Content-Length if available
      const contentLength = response.headers.get('content-length');
      if (contentLength && Number(contentLength) > MAX_DOWNLOAD_BYTES) {
        throw new Error(`Download too large: ${contentLength} bytes exceeds ${MAX_DOWNLOAD_BYTES} limit`);
      }

      // Stream to disk with byte counting
      let bytesWritten = 0;
      const webStream = response.body;
      const nodeStream = Readable.fromWeb(webStream as never);
      const writeStream = fs.createWriteStream(filePath);

      const countingStream = new Readable({
        read() {},
      });

      nodeStream.on('data', (chunk: Buffer) => {
        bytesWritten += chunk.length;
        if (bytesWritten > MAX_DOWNLOAD_BYTES) {
          nodeStream.destroy(new Error(`Download exceeded ${MAX_DOWNLOAD_BYTES} byte limit`));
          return;
        }
        countingStream.push(chunk);
      });
      nodeStream.on('end', () => countingStream.push(null));
      nodeStream.on('error', (err) => countingStream.destroy(err));

      await pipeline(countingStream, writeStream);
      return filePath;
    } finally {
      clearTimeout(timer);
    }
  }

  getBaseDir(): string {
    return this.baseDir;
  }

  private guessExtension(url: string, filename?: string): string {
    if (filename) {
      const ext = path.extname(filename);
      if (ext) return ext;
    }
    try {
      const urlPath = new URL(url).pathname;
      const ext = path.extname(urlPath);
      if (ext && ext.length <= 5) return ext;
    } catch {
      // ignore URL parse errors
    }
    return '.mp4';
  }
}
