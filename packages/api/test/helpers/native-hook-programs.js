import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));

function privateHookIsUnexported(root, hook) {
  // The home manifest is intentionally absent from public exports. Missing a
  // hook in a home checkout still runs the entry and fails; it is never waived.
  return !existsSync(resolve(root, 'sync-manifest.yaml')) && !existsSync(resolve(root, hook));
}

export function nativeHookPrograms(root = repositoryRoot) {
  const programs = [[process.execPath, resolve(root, 'scripts/native-effect-target-guard.mjs'), 'exec_command']];
  const hook = '.claude/hooks/runtime-sanctuary-guard.sh';
  if (!privateHookIsUnexported(root, hook)) programs.push(['/bin/bash', resolve(root, hook), 'Bash']);
  return programs;
}

export function gateHookProgram(root = repositoryRoot) {
  const hook = '.claude/hooks/gate-background-guard.sh';
  return privateHookIsUnexported(root, hook)
    ? [process.execPath, resolve(root, 'scripts/gate-background-decision.mjs')]
    : ['/bin/bash', resolve(root, hook)];
}
