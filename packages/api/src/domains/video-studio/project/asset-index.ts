import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { type VideoProjectAssetVersion, videoProjectLocatorSchema } from '@cat-cafe/shared';
import type { WorkspaceContentRootResolution } from '../../workspace/workspace-content-source.js';
import {
  canonicalizeWorkspaceContentLocator,
  digestWorkspaceFile,
  hasSameWorkspaceFileState,
  openedWorkspaceContentMatchesCanonicalLocator,
} from '../../workspace/workspace-content-source-utils.js';

type Locator = VideoProjectAssetVersion['locator'];
export type IndexedAssetRead = { state: 'available'; bytes: Buffer } | { state: 'missing' | 'changed' };

/** F063's root/realpath/descriptor guards; an indexed version never grants its own path authority. */
export class VideoProjectAssetIndex {
  constructor(
    private readonly options: {
      readonly resolveRoot: (rootId: string) => Promise<WorkspaceContentRootResolution>;
      readonly maxBytes?: number;
    },
  ) {}

  async inspect(locator: Locator): Promise<{ sha256: `sha256:${string}`; byteLength: number; locator: Locator }> {
    const file = await this.readStable(locator, false);
    return { sha256: file.digest, byteLength: file.byteLength, locator: file.locator };
  }

  async read(version: VideoProjectAssetVersion): Promise<IndexedAssetRead> {
    try {
      const file = await this.readStable(version.locator, true);
      if (file.digest !== version.sha256 || file.byteLength !== version.byteLength) return { state: 'changed' };
      if (!file.bytes) throw new Error('Asset bytes unavailable');
      return { state: 'available', bytes: file.bytes };
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { state: 'missing' };
      throw error;
    }
  }

  private async readStable(locator: Locator, collectBytes: boolean) {
    videoProjectLocatorSchema.parse(locator);
    if (locator.kind !== 'workspace') throw new Error('Unsupported asset locator');
    const resolution = await this.options.resolveRoot(locator.rootId);
    if (resolution.canonicalWorktreeId !== locator.rootId) throw new Error('Asset root identity changed');
    const root = await realpath(resolution.root);
    const canonical = await canonicalizeWorkspaceContentLocator(root, {
      worktreeId: locator.rootId,
      path: locator.path,
    });
    const handle = await open(canonical.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > (this.options.maxBytes ?? 256 * 1024 * 1024))
        throw new Error('Asset is not a bounded regular file');
      const checked = await digestWorkspaceFile(handle, before.size, collectBytes);
      if (
        !hasSameWorkspaceFileState(before, await handle.stat()) ||
        checked.byteLength !== before.size ||
        !(await openedWorkspaceContentMatchesCanonicalLocator(root, canonical.path, canonical.locator, handle))
      )
        throw new Error('Asset changed during verification');
      return {
        ...checked,
        locator: { kind: 'workspace' as const, rootId: locator.rootId, path: canonical.locator.path },
      };
    } finally {
      await handle.close();
    }
  }
}
