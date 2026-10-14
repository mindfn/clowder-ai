import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { PluginTaskInvocationBinding } from '../../cats/services/agents/invocation/plugin-task-invocation-binding.js';
import { readBoundedPackageFile } from '../external-runtime/bounded-package-file.js';

export const TASK_TEXT_BUDGET = 65_536;
export type TaskTextMediaType = 'text/markdown' | 'text/plain';
export function taskTextDigest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function scope(binding: PluginTaskInvocationBinding, invocationId: string): string {
  return taskTextDigest(
    Buffer.from(
      JSON.stringify([
        binding.pluginInstanceId,
        binding.ownerUserId,
        binding.taskId,
        binding.executionRef,
        invocationId,
      ]),
    ),
  );
}
export function taskTextFileName(
  binding: PluginTaskInvocationBinding,
  invocationId: string,
  digest: string,
  mediaType: TaskTextMediaType,
): string {
  return `task-${scope(binding, invocationId)}-${digest}.${mediaType === 'text/markdown' ? 'md' : 'txt'}`;
}
export function parseTaskTextRef(binding: PluginTaskInvocationBinding, invocationId: string, ref: string) {
  const match = /^task-artifact:(task-([a-f0-9]{64})-([a-f0-9]{64})\.(md|txt))$/.exec(ref);
  if (!match || !match[1] || !match[3] || match[2] !== scope(binding, invocationId))
    throw new Error('Task artifact scope mismatch');
  return {
    fileName: match[1],
    digest: match[3],
    mediaType: (match[4] === 'md' ? 'text/markdown' : 'text/plain') as TaskTextMediaType,
  };
}
export function decodeTaskText(bytes: Buffer): string {
  if (bytes.length === 0 || bytes.length > TASK_TEXT_BUDGET) throw new Error('Task artifact byte budget exceeded');
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  if (text.includes('\0')) throw new Error('Task artifact contains NUL');
  return text;
}
export async function readTaskTextFile(root: string, fileName: string, digest: string) {
  await assertPrivateDirectory(root);
  const bytes = await readBoundedPackageFile(root, fileName, TASK_TEXT_BUDGET);
  if (taskTextDigest(bytes) !== digest) throw new Error('Task artifact digest changed');
  return { text: decodeTaskText(bytes), byteLength: bytes.length };
}
async function assertPrivateDirectory(root: string): Promise<void> {
  // A pre-existing symlink must not redirect private bytes into a statically served directory.
  if (!(await lstat(root)).isDirectory()) throw new Error('Task artifact directory is not a private directory');
}
/** Publish complete immutable bytes atomically; a crash never exposes a partially written final name. */
export async function writeTaskTextFile(root: string, fileName: string, bytes: Buffer): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await assertPrivateDirectory(root);
  const physicalRoot = await realpath(root);
  const temporary = join(physicalRoot, `.task-${randomUUID()}.tmp`);
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    try {
      await link(temporary, join(physicalRoot, fileName));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const directory = await open(physicalRoot, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    // Existing bytes are never overwritten, even if an earlier crash or external writer corrupted them.
    await readTaskTextFile(physicalRoot, fileName, taskTextDigest(bytes));
  } finally {
    await unlink(temporary);
  }
}
