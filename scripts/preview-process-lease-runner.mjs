#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { renameSync, writeFileSync } from 'node:fs';
import {
  cleanupOwnerResultPath,
  previewCleanupExitCode,
  readCleanupOwnerResult,
} from './lib/preview-cleanup-result.mjs';
import { processGroupExists, waitForProcessGroupExit } from './lib/preview-process-runtime.mjs';

// start-dev drains application children for eight seconds before saving Redis.
const TERM_GRACE_MS = 30_000;

function parseArgs(argv) {
  const separator = argv.indexOf('--');
  if (
    argv[0] !== '--expires-at' ||
    !argv[1] ||
    ![2, 4].includes(separator) ||
    (separator === 4 && argv[2] !== '--completion-path')
  ) {
    throw new Error('usage: preview-process-lease-runner --expires-at ISO -- COMMAND [ARGS...]');
  }
  const expiresAt = Date.parse(argv[1]);
  const command = argv.slice(separator + 1);
  if (!Number.isFinite(expiresAt) || command.length === 0) throw new Error('invalid expiry or empty command');
  return { command, expiresAt, completionPath: separator === 4 ? argv[3] : undefined };
}

function signalOwnedChild(child, signal) {
  // pnpm/shell wrappers can exit while their process group is still draining.
  if (!child.pid) return;
  try {
    process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

async function terminate(child, reason) {
  process.stderr.write(`[preview-process] ${reason}; terminating managed preview\n`);
  signalOwnedChild(child, 'SIGTERM');
  if (!(await waitForProcessGroupExit(child, TERM_GRACE_MS))) {
    signalOwnedChild(child, 'SIGKILL');
    await waitForProcessGroupExit(child, 1_000);
    return false;
  }
  return true;
}

async function main() {
  const { command, expiresAt, completionPath } = parseArgs(process.argv.slice(2));
  const ownerResultPath = cleanupOwnerResultPath(completionPath);
  const child = spawn(command[0], command.slice(1), {
    detached: process.platform !== 'win32',
    stdio: 'inherit',
    env: {
      ...process.env,
      CAT_CAFE_PREVIEW_EXPIRES_AT: new Date(expiresAt).toISOString(),
      CAT_CAFE_PREVIEW_CLEANUP_RESULT: ownerResultPath ?? '',
    },
  });
  let shutdownPromise;
  const shutdown = (reason) => (shutdownPromise ??= terminate(child, reason));
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      void shutdown(`received ${signal}`);
    });
  }
  const expiryTimer = setTimeout(
    () => {
      void shutdown(`lease expired at ${new Date(expiresAt).toISOString()}`);
    },
    Math.max(0, expiresAt - Date.now()),
  );
  const outcome = await new Promise((resolveExit) => {
    child.once('exit', (exitCode, exitSignal) => resolveExit({ code: exitCode, signal: exitSignal }));
    child.once('error', (error) => resolveExit({ error }));
  });
  clearTimeout(expiryTimer);
  if (outcome.error) {
    process.stderr.write(`[preview-process] preview command failed to start: ${outcome.error.message}\n`);
    process.exitCode = 1;
    return;
  }
  const shutdownRequested = Boolean(shutdownPromise);
  const descendantsRemain = processGroupExists(child);
  if (!shutdownPromise && descendantsRemain) shutdown('preview command exited');
  const graceful = shutdownPromise ? await shutdownPromise : true;
  const owner = readCleanupOwnerResult(ownerResultPath, child.pid);
  const exitCode = previewCleanupExitCode({
    outcome,
    graceful,
    owner,
    descendantsRemain,
    shutdownRequested,
    requireOwnerResult: Boolean(completionPath),
  });
  if (completionPath) {
    const temporaryPath = `${completionPath}.${process.pid}.tmp`;
    writeFileSync(
      temporaryPath,
      JSON.stringify({
        pid: process.pid,
        expiresAt: new Date(expiresAt).toISOString(),
        exitCode,
        forced: !graceful,
        cleanupOwnerStatus: owner.status,
        completedAt: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );
    renameSync(temporaryPath, completionPath);
  }
  process.exitCode = exitCode;
}

try {
  await main();
} catch (error) {
  process.stderr.write(`[preview-process] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
