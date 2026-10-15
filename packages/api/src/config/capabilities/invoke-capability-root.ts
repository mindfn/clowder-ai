import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { redirectRuntimeProjectPath } from '../../utils/persistent-project-path.js';
import { pathsEqual } from '../../utils/project-path.js';

/** Use the same persistent default as Settings; executable roots remain runtime-owned. */
export async function resolveInvokeCapabilityRoot(binaryRoot: string): Promise<string> {
  // Standalone/dev callers without a declared workspace retain their existing source.
  if (
    !process.env.CAT_CAFE_RUNTIME_ROOT?.trim() ||
    (!process.env.CAT_CAFE_WORKSPACE_ROOT?.trim() && process.env.CAT_CAFE_DEPLOYMENT_ID !== 'alpha')
  ) {
    return binaryRoot;
  }
  const root = await redirectRuntimeProjectPath(binaryRoot);
  if (!root) throw new Error('Unable to resolve persistent global capabilities root');
  return root;
}

/** A declared persistent source is authority, including absence; do not enable default tools on read failure. */
export function assertMappedCapabilitySource(resolved: boolean, binaryRoot: string, configRoot: string): void {
  if (!resolved && !isSameCapabilityRoot(binaryRoot, configRoot)) {
    throw new Error('Persistent capabilities source is missing or unreadable');
  }
}

/** Path spelling must not select a less restrictive project policy for the same global source. */
export function isSameCapabilityRoot(left: string, right: string): boolean {
  if (pathsEqual(resolve(left), resolve(right))) return true;
  try {
    return pathsEqual(realpathSync(left), realpathSync(right));
  } catch {
    // A missing project retains the existing project-read → global-read behavior.
    return false;
  }
}
