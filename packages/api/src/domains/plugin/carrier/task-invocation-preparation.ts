import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync, type Stats } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  capturePluginTaskBinding,
  capturePluginTaskInvocationAuth,
  type PluginTaskCurrentnessInput,
  type PluginTaskInvocationBinding,
} from '../../cats/services/agents/invocation/plugin-task-invocation-binding.js';
import type { PublicInvocationExecution } from '../../cats/services/agents/invocation/public-invocation-execution.js';
import type { ToolExecutionPolicy } from '../../cats/services/types.js';
import type { NativeMcpServer } from '../declared/native-mcp-launches.js';
import { pluginTaskDispatchContent } from '../host-surface/plugin-task-receipt.js';
import type { PublicInvocationSourceServices } from './public-invocation-currentness.js';
import type { PublicInvocationVerifierContext } from './public-invocation-verifier.js';
import type { PluginRuntimeAdmission } from './runtime-carrier.js';

interface Ports {
  readonly sources: PublicInvocationSourceServices | undefined;
  readonly workspaceRoot: string | undefined;
  admission(instanceId: string): Promise<PluginRuntimeAdmission>;
  resolve(policy: ToolExecutionPolicy): Promise<NativeMcpServer>;
  skills(admission: PluginRuntimeAdmission): Promise<string>;
  generation(instanceId: string): number;
}
function refuse(): never {
  throw new Error('task_launch_authority_unavailable');
}
function assertAdmission(
  admission: PluginRuntimeAdmission,
  input: Pick<PluginTaskCurrentnessInput, 'pluginTaskBinding' | 'toolExecutionPolicy'>,
) {
  const b = input.pluginTaskBinding;
  const policy = input.toolExecutionPolicy;
  const { instance, packageRecord: pkg, effectiveGrants: grants } = admission;
  if (
    !b ||
    policy?.mode !== 'plugin_native' ||
    instance.pluginInstanceId !== b.pluginInstanceId ||
    instance.packageDigest !== b.packageDigest ||
    instance.lifecycleRevision !== b.lifecycleRevision ||
    instance.lifecycleState !== 'installed' ||
    instance.activationState !== 'enabled' ||
    instance.configReadiness !== 'ready' ||
    instance.runtimeState !== 'healthy' ||
    admission.grantRevision !== b.grantRevision ||
    !grants.includes('task.admitEntrusted') ||
    pkg.packageState !== 'installed' ||
    pkg.packageDigest !== b.packageDigest ||
    pkg.pluginId !== instance.pluginId
  )
    refuse();
  const declarations =
    pkg.manifest.contributions?.filter((c) => c.type === 'mcp' && c.id === policy.contributionId) ?? [];
  const declaration = declarations[0];
  const owners = pkg.manifest.features.filter((f) =>
    f.contributions?.some((c) => c.type === 'mcp' && c.id === policy.contributionId),
  );
  if (
    declarations.length !== 1 ||
    declaration?.type !== 'mcp' ||
    owners.length !== 1 ||
    !owners[0]?.capabilities.some((c: string) => c === 'task.admitEntrusted') ||
    !owners[0].capabilities.every((c) => grants.includes(c)) ||
    !policy.actionMethods.every((method) => declaration.actions?.some((a) => a.method === method))
  )
    refuse();
}

/** Internal Queue preflight: derive methods from installed declarations, never from the trigger body. */
export async function resolveTaskInvocationPolicy(
  raw: PluginTaskInvocationBinding,
  assertCurrent: () => Promise<void>,
  ports: Pick<Ports, 'admission' | 'resolve' | 'generation'>,
): Promise<Extract<ToolExecutionPolicy, { mode: 'plugin_native' }>> {
  const binding = capturePluginTaskBinding(raw);
  const generation = ports.generation(binding.pluginInstanceId);
  await assertCurrent();
  const admission = structuredClone(await ports.admission(binding.pluginInstanceId));
  const manifest = admission.packageRecord.manifest;
  const candidates = (manifest.contributions ?? []).filter(
    (c) =>
      c.type === 'mcp' &&
      manifest.features.some(
        (f) =>
          f.capabilities.some((v: string) => v === 'task.admitEntrusted') &&
          f.contributions?.some((ref) => ref.type === 'mcp' && ref.id === c.id),
      ),
  );
  const declaration = candidates[0];
  if (candidates.length !== 1 || declaration?.type !== 'mcp' || !declaration.actions?.length) refuse();
  const methods = declaration.actions.map((a) => a.method);
  if (new Set(methods).size !== methods.length) refuse();
  const policy = Object.freeze({
    mode: 'plugin_native' as const,
    pluginInstanceId: binding.pluginInstanceId,
    contributionId: declaration.id,
    actionMethods: Object.freeze(methods),
  });
  assertAdmission(admission, { pluginTaskBinding: binding, toolExecutionPolicy: policy });
  await ports.resolve(policy);
  const current = structuredClone(await ports.admission(binding.pluginInstanceId));
  assertAdmission(current, { pluginTaskBinding: binding, toolExecutionPolicy: policy });
  if (!isDeepStrictEqual(admission, current) || ports.generation(binding.pluginInstanceId) !== generation) refuse();
  await assertCurrent();
  return policy;
}

function physicalDirectory(path: string): Stats {
  const s = lstatSync(path);
  if (!s.isDirectory() || s.isSymbolicLink() || realpathSync(path) !== path) refuse();
  return s;
}
function sameDirectory(path: string, original: Stats, privateMode: boolean) {
  const current = physicalDirectory(path);
  if (current.dev !== original.dev || current.ino !== original.ino || (privateMode && (current.mode & 0o777) !== 0o700))
    refuse();
}
function overlaps(a: string, b: string) {
  const rel = relative(a, b);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Persistent artifacts belong to the Task. Disposal revokes execution, never removes this tree. */
function allocateTaskWorkspace(root: string, input: PluginTaskCurrentnessInput, skills: string) {
  if (!isAbsolute(root) || !isAbsolute(skills)) refuse();
  // The Host's persistence parent already exists. Never follow a caller-selected/symlink parent.
  physicalDirectory(dirname(root));
  if (overlaps(root, skills) || overlaps(skills, root)) refuse();
  const identities = new Map<string, Stats>();
  const directory = (path: string, fresh = false) => {
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if (fresh || (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const identity = physicalDirectory(path);
    sameDirectory(path, identity, true);
    identities.set(path, identity);
  };
  directory(root);
  const b = input.pluginTaskBinding;
  const key = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const taskRoot = join(root, key([b.ownerUserId, b.pluginInstanceId, b.taskId]));
  directory(taskRoot);
  const executionRoot = join(taskRoot, key(b.executionRef));
  directory(executionRoot);
  const workspaceRoot = join(executionRoot, key(input.invocationId));
  directory(workspaceRoot, true);
  const skillsIdentity = physicalDirectory(skills);
  return {
    workspaceRoot,
    assertCurrent() {
      for (const [path, identity] of identities) sameDirectory(path, identity, true);
      sameDirectory(skills, skillsIdentity, false);
    },
  };
}

/** Only Host registration supplies this credential-free principal and the Registry's latest fence. */
export async function prepareTaskInvocationExecution(
  raw: PluginTaskCurrentnessInput,
  authority: PublicInvocationVerifierContext,
  ports: Ports,
): ReturnType<PublicInvocationExecution['prepare']> {
  const input = capturePluginTaskInvocationAuth({ ...raw });
  const b = input.pluginTaskBinding,
    policy = input.toolExecutionPolicy;
  const check = authority.assertCurrent,
    externalSignal = authority.signal;
  if (
    !b ||
    policy?.mode !== 'plugin_native' ||
    !input.invocationId ||
    !ports.workspaceRoot ||
    ports.sources?.ownerUserId !== b.ownerUserId ||
    typeof check !== 'function' ||
    !(externalSignal instanceof AbortSignal)
  )
    refuse();
  const lifetime = new AbortController(),
    signal = AbortSignal.any([externalSignal, lifetime.signal]);
  const generation = ports.generation(b.pluginInstanceId);
  let originalServer: NativeMcpServer | undefined;
  let server: NativeMcpServer | undefined;
  let admissionSnapshot: PluginRuntimeAdmission | undefined;
  let source: { readonly messageId: string; readonly content: string } | undefined;
  let skills: string | undefined;
  let workspace: ReturnType<typeof allocateTaskWorkspace> | undefined;
  const dispose = () => lifetime.abort(new Error('task_launch_disposed'));
  const assertCurrent = async () => {
    try {
      signal.throwIfAborted();
      workspace?.assertCurrent();
      await check();
      signal.throwIfAborted();
      const admission = structuredClone(await ports.admission(b.pluginInstanceId));
      assertAdmission(admission, input);
      if (admissionSnapshot && !isDeepStrictEqual(admission, admissionSnapshot)) refuse();
      admissionSnapshot ??= admission;
      const message = structuredClone(await ports.sources!.messageStore.getById(b.triggerMessageId));
      if (
        !message ||
        message.id !== b.triggerMessageId ||
        message.userId !== b.ownerUserId ||
        message.catId !== null ||
        message.threadId !== b.threadId ||
        message.source ||
        message.deletedAt ||
        message._tombstone ||
        message.recall ||
        message.sourceParseFailure ||
        message.deliveryStatus !== 'queued' ||
        message.content !== pluginTaskDispatchContent(b)
      )
        refuse();
      source ??= Object.freeze({ messageId: message.id, content: message.content });
      const currentServer = await ports.resolve(policy);
      signal.throwIfAborted();
      if (
        ports.generation(b.pluginInstanceId) !== generation ||
        (originalServer && (currentServer !== originalServer || !isDeepStrictEqual(currentServer, server)))
      )
        refuse();
      originalServer = currentServer;
      server ??= Object.freeze({
        ...currentServer,
        args: Object.freeze([...currentServer.args]),
        env: Object.freeze({ ...currentServer.env }),
      });
      skills ??= await ports.skills(admission);
      await check();
      signal.throwIfAborted();
      workspace?.assertCurrent();
    } catch (error) {
      lifetime.abort(error);
      throw error;
    }
  };
  try {
    await assertCurrent();
    if (!skills || !source || !server) refuse();
    workspace = allocateTaskWorkspace(ports.workspaceRoot, input, skills);
    await assertCurrent();
    return Object.freeze({
      source,
      launch: Object.freeze({
        server,
        sandbox: Object.freeze({
          kind: 'entrusted_work' as const,
          workspaceRoot: workspace.workspaceRoot,
          runtimeSkillsRoot: skills,
          taskBinding: b,
        }),
        assertCurrent,
      }),
      dispose,
    });
  } catch (error) {
    dispose();
    throw error;
  }
}
