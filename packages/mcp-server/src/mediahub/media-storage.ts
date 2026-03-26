/**
 * MediaHub — Media Storage
 * F139: Downloads generated media to local filesystem.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const DEFAULT_OUTPUT_DIR = 'data/mediahub/outputs';

export class MediaStorage {
  private readonly baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? path.resolve(process.cwd(), DEFAULT_OUTPUT_DIR);
  }

  /** Ensure output directory exists for a given provider/job */
  private ensureJobDir(providerId: string, jobId: string): string {
    const dir = path.join(this.baseDir, providerId, jobId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Download a media file from URL and save locally. Returns local file path. */
  async download(providerId: string, jobId: string, url: string, filename?: string): Promise<string> {
    const dir = this.ensureJobDir(providerId, jobId);
    const ext = this.guessExtension(url, filename);
    const outFile = filename ?? `output${ext}`;
    const filePath = path.join(dir, outFile);

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Download failed (${response.status}): ${url}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(filePath, buffer);
    return filePath;
  }

  /** Get the output directory path */
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
    return '.mp4'; // default for video
  }
}
