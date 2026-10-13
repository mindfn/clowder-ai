import { mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { createCatId } from '@cat-cafe/shared';
import type { AgentServiceOptions } from '../../types.js';
import { capturePluginTaskInvocationAuth } from '../invocation/plugin-task-invocation-binding.js';
import { buildCodexNativeEffectGuardArgs } from './CodexNativeEffectGuard.js';

function within(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

/** Captures a Host-derived Task launch; this function does not mint Task authority. */
export function captureTaskSandbox(options: AgentServiceOptions) {
  const sandbox = options.pluginNativeLaunch?.sandbox;
  if (sandbox?.kind !== 'entrusted_work') return undefined;
  const env = { ...options.callbackEnv };
  if (!sandbox.taskBinding || !env.CAT_CAFE_API_URL || !env.CAT_CAFE_INVOCATION_ID || !env.CAT_CAFE_CALLBACK_TOKEN)
    throw Error('plugin_task_launch_identity_missing');
  capturePluginTaskInvocationAuth({
    userId: env.CAT_CAFE_USER_ID ?? '',
    catId: createCatId(env.CAT_CAFE_CAT_ID ?? ''),
    threadId: env.CAT_CAFE_THREAD_ID ?? '',
    ownerAuthProvenance: 'unknown',
    originTriggerMessageId: sandbox.taskBinding.triggerMessageId,
    pluginTaskBinding: sandbox.taskBinding,
    toolExecutionPolicy: options.toolExecutionPolicy,
  });
  const api = new URL(env.CAT_CAFE_API_URL);
  if (
    !['http:', 'https:'].includes(api.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(api.hostname) ||
    api.username ||
    api.password ||
    api.pathname !== '/' ||
    api.search ||
    api.hash
  )
    throw Error('plugin_task_launch_invalid_host');
  if (!isAbsolute(sandbox.workspaceRoot) || !isAbsolute(sandbox.runtimeSkillsRoot))
    throw Error('plugin_task_launch_invalid_root');
  const workspace = realpathSync(sandbox.workspaceRoot),
    skills = realpathSync(sandbox.runtimeSkillsRoot);
  if (within(workspace, skills) || within(skills, workspace)) throw Error('plugin_task_launch_overlapping_roots');
  const skillsStat = statSync(skills);
  if (!skillsStat.isDirectory()) throw Error('plugin_task_launch_invalid_skills');
  const skillsPath = sandbox.runtimeSkillsRoot;
  const credentials = JSON.stringify({
    apiUrl: api.origin,
    invocationId: env.CAT_CAFE_INVOCATION_ID,
    callbackToken: env.CAT_CAFE_CALLBACK_TOKEN,
  });
  return {
    assertCurrent() {
      const current = statSync(skills);
      if (realpathSync(skillsPath) !== skills || current.dev !== skillsStat.dev || current.ino !== skillsStat.ino)
        throw Error('plugin_task_launch_skills_changed');
    },
    args(controlRoot: string): string[] {
      if (
        within(workspace, controlRoot) ||
        within(skills, controlRoot) ||
        within(controlRoot, workspace) ||
        within(controlRoot, skills)
      )
        throw Error('plugin_task_launch_control_overlap');
      const admissionFile = join(controlRoot, 'task-admission.json');
      writeFileSync(admissionFile, credentials, { mode: 0o600, flag: 'wx' });
      const shellHome = join(workspace, '.task-home'),
        shellTmp = join(workspace, '.task-tmp');
      for (const dir of [shellHome, shellTmp]) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        if (!within(workspace, realpathSync(dir))) throw Error('plugin_task_launch_shell_root_escape');
      }
      const fs = Object.entries({ '/': 'deny', ':minimal': 'read', [workspace]: 'write', [skills]: 'read' })
        .map(([key, value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`)
        .join(',');
      const shellEnv = Object.entries({
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: shellHome,
        TMPDIR: shellTmp,
      })
        .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
        .join(',');
      // The caller already emitted the first --config. No provider/bearer env reaches shell tools.
      return [
        'default_permissions="plugin_native_task"',
        '--config',
        `permissions.plugin_native_task.filesystem={${fs}}`,
        '--config',
        'permissions.plugin_native_task.network={enabled=false}',
        '--config',
        'shell_environment_policy.inherit="none"',
        '--config',
        `shell_environment_policy.set={${shellEnv}}`,
        ...['shell_tool', 'unified_exec', 'apply_patch_freeform'].flatMap((feature) => [
          '--config',
          `features.${feature}=true`,
        ]),
        ...buildCodexNativeEffectGuardArgs({ taskAdmissionFile: admissionFile }),
      ];
    },
  };
}
