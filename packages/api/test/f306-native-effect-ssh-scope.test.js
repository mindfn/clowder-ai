import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { decideAgyNativeHookPayload } from '../../../scripts/agy-native-effect-guard.mjs';
import { decideNativeHookPayload } from '../../../scripts/native-effect-target-guard.mjs';
import { nativeHookPrograms, nativeHookTestEnv } from './helpers/native-hook-programs.js';
import { reportSystemSshRunnerInputs } from './helpers/system-ssh-runner-inputs.js';

const root = mkdtempSync(join(tmpdir(), 'f306-ssh-scope-'));
const main = join(root, 'cat-cafe');
const runtime = join(root, 'cat-cafe-runtime');
for (const path of [main, runtime]) mkdirSync(path);
after(() => rmSync(root, { recursive: true, force: true }));
const hosted = {
  installation: { deploymentId: 'runtime', projectRoot: runtime },
  runtime: { worktree: runtime, apiPid: 4242, apiPort: 3002 },
  hostDependencies: [{ kind: 'redis', port: 6399 }],
};
const options = {
  selfHost: () => ({ confidence: 'current', facet: hosted }),
  observeHost: () => ({}),
  sshScope: { configFiles: [], localAddresses: [] },
};
const prefix = `ssh -i '${root}/identity' -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=12 root@203.0.113.8`;
const body =
  'systemctl stop clowder-collective.service\ntar -cf /srv/private/backup.tar /srv/collective\nsystemctl start clowder-collective.service';
const script = (head = `${prefix} 'bash -se'`, quoted = true) =>
  `${head} <<${quoted ? "'REMOTE'" : 'REMOTE'}\n${body}\nREMOTE\n`;
const payload = (command, tool_name = 'Bash', cwd = main) => ({
  tool_name,
  cwd,
  tool_input: { command },
  ...(tool_name === 'exec_command' ? { turn_id: 'ssh-scope-turn', tool_use_id: 'ssh-scope-call' } : {}),
});
const decide = (command, cwd = main, extra = {}) =>
  decideNativeHookPayload(payload(command, 'Bash', cwd), { ...options, ...extra });

test('source546: a literal remote SSH service has a remote coordinate in both provider payloads', () => {
  for (const cwd of [main, runtime])
    for (const provider of ['Bash', 'exec_command']) {
      const result = decideNativeHookPayload(payload(script(), provider, cwd), options);
      assert.equal(result.decision, 'allow', JSON.stringify(result));
      assert.equal(result.reasonCode, 'remote_ssh_policy_deferred');
      assert.equal(result.effect, 'unknown', 'an opaque remote script is not certified read-only');
      assert.equal(result.source.provider, provider === 'Bash' ? 'claude' : 'codex');
      assert.equal(result.target.value, 'ssh://root@203.0.113.8:22');
      assert.ok(!result.target.value.includes('identity'), '-i is a local input, not the service target');
    }
});

test('the final native shell execution payload uses its actual local cwd and the same SSH scope', () => {
  for (const [command, decision] of [
    [script(), 'allow'],
    [`${prefix} true > '${runtime}/.env'`, 'deny'],
  ]) {
    const input = {
      cwd: main,
      turn_id: 'ssh-scope-turn',
      tool_use_id: 'ssh-scope-call',
      tool_name: 'Bash',
      hook_event_name: 'NativeShellSafetyCheck',
      session_id: 'ssh-session',
      native_execution: {
        plan_id: 'ssh-plan',
        call_id: 'ssh-scope-call',
        turn_id: 'ssh-scope-turn',
        environment_id: 'local',
        cwd_uri: pathToFileURL(runtime).href,
        argv: ['/bin/bash', '-c', command],
        command,
        phase: 'before_first_effect',
        constraints: {},
        fingerprint: 'a'.repeat(40),
      },
    };
    const result = decideNativeHookPayload(input, options);
    assert.equal(result.decision, decision, JSON.stringify(result));
    assert.equal(result.source.cwd, runtime);
  }
});

test('remote argv and remote shell source have the same destination attribution', () => {
  for (const head of [prefix, prefix.replace('ssh ', 'ssh -C ')])
    for (const tail of ["'systemctl stop clowder-collective.service'", 'systemctl stop clowder-collective.service']) {
      const result = decide(`${head} ${tail}`);
      assert.equal(result.decision, 'allow', JSON.stringify(result));
      assert.equal(result.target.value, 'ssh://root@203.0.113.8:22');
    }
});

test('local expansions, redirections, and commands following SSH retain local protection', () => {
  for (const command of [
    script(`${prefix} 'bash -se' > '${runtime}/.env'`),
    `${script()}\nkill -TERM 4242`,
    `${prefix} "$(kill -TERM 4242)"`,
    `${prefix} true > '${runtime}/.env'`,
    script().replace("<<'REMOTE'", '<<REMOTE').replace(body, `$(kill -TERM 4242)\n${body}`),
  ])
    assert.equal(decide(command, runtime).decision, 'deny', command);
  assert.notEqual(
    decide(`${prefix} 'systemctl stop x' | bash`, runtime).reasonCode,
    'remote_ssh_policy_deferred',
    'SSH output consumed by a local shell is not a remote-only certificate',
  );
});

test('SSH local-command options and uncertain or local destinations never obtain remote scope', () => {
  for (const command of [
    script().replace('root@203.0.113.8', 'root@127.0.0.1'),
    script().replace('root@203.0.113.8', 'root@localhost'),
    script().replace('root@203.0.113.8', 'root@$HOST'),
    script().replace('root@203.0.113.8', 'root@0.0.0.0'),
    script().replace('-o BatchMode=yes', "-o 'ProxyCommand=kill -TERM 4242'"),
    script().replace('-o BatchMode=yes', "-o 'LocalCommand=kill -TERM 4242' -o PermitLocalCommand=yes"),
    script().replace('-o BatchMode=yes', '-o HostName=127.0.0.1'),
  ])
    assert.equal(decide(command).decision, 'deny', command);
  assert.equal(
    decide(script(), main, { sshScope: { configFiles: [], localAddresses: ['203.0.113.8'] } }).decision,
    'deny',
  );
});

test('a local ProxyCommand remains protected even when the remote command itself is harmless', () => {
  for (const name of ['ProxyCommand', 'LocalCommand', 'KnownHostsCommand']) {
    const command = `${prefix.replace('-o BatchMode=yes', `-o '${name}=kill -TERM 4242'`)} true`;
    assert.equal(decide(command).decision, 'deny', name);
  }
});

test('loopback and unresolved SSH command strings keep explicit local stop targets visible', () => {
  for (const host of ['127.0.0.1', 'localhost', 'unknown.example', '::1']) {
    const command = `${prefix.replace('203.0.113.8', host)} 'kill -TERM 4242'`;
    assert.equal(decide(command).decision, 'deny', host);
  }
});

test('SSH configuration cannot hide a local executor or change the target to loopback', () => {
  const config = join(root, 'ssh-config');
  const extra = { sshScope: { configFiles: [config], localAddresses: [] } };
  for (const directive of [
    'ProxyCommand kill -TERM 4242',
    'LocalCommand kill -TERM 4242',
    'HostName 127.0.0.1',
    'Match exec "kill -TERM 4242"',
  ]) {
    writeFileSync(config, `Host *\n  ${directive}\n`);
    assert.equal(decide(script(), main, extra).decision, 'deny', directive);
  }
  writeFileSync(config, 'Host unrelated.example\n HostName 127.0.0.1\nHost *\n IdentitiesOnly yes\n');
  assert.equal(
    decide(script(), main, extra).decision,
    'allow',
    'unrelated aliases do not relocate a literal destination',
  );
});

test('both real hook CLIs use remote attribution and keep denial audit in a private HOME', (t) => {
  reportSystemSshRunnerInputs(t);
  for (const [program, hook, provider] of nativeHookPrograms()) {
    const env = nativeHookTestEnv({ ...process.env, CAT_CAFE_DEPLOYMENT_ID: 'runtime' });
    for (const [command, denied] of [
      [script(), false],
      [`${prefix} true > '${runtime}/.env'`, true],
      ["ssh root@203.0.113.8 -o 'ProxyCommand=kill -TERM 4242' true", true],
    ]) {
      const result = spawnSync(program, [hook], {
        env,
        input: JSON.stringify(payload(command, provider, runtime)),
        encoding: 'utf8',
        timeout: 10000,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.includes('"permissionDecision":"deny"'), denied, result.stdout);
    }
  }
});

test('controlled SSH config with remote ProxyJump and isolated ControlMaster allows remote commands and -O check', () => {
  const config = join(root, 'ascend-ssh-config');
  writeFileSync(
    config,
    [
      'Host jump-ali',
      '  HostName 203.0.113.8',
      '  User root',
      '  IdentityFile ~/.ssh/aliyun',
      'Host ascend',
      '  HostName 127.0.0.1',
      '  Port 2222',
      '  User root',
      '  ProxyJump jump-ali',
      '  ControlMaster auto',
      '  ControlPath ~/.ssh/cm-%C',
      '  ControlPersist 7d',
      '  ServerAliveInterval 30',
      '  ServerAliveCountMax 3',
      'Host direct-remote',
      '  HostName 203.0.113.9',
      'Host local-only',
      '  HostName 127.0.0.1',
      '  ControlMaster auto',
      '  ControlPath ~/.ssh/cm-%C',
      'Host local-jump',
      '  HostName 127.0.0.1',
      '  ProxyJump 127.0.0.1',
      'Host bad-cm',
      '  HostName 203.0.113.9',
      '  ControlMaster auto',
      '  ControlPath ~/.ssh/shared.sock',
      'Host loop',
      '  ProxyCommand none',
      '  ProxyJump 8.8.8.8',
      '  HostName 127.0.0.1',
      'Host lanback',
      '  ProxyJump 8.8.8.8',
      '  HostName 192.168.1.50',
      'Host lanback-hop',
      '  ProxyJump 8.8.8.8,192.168.1.50',
      '  HostName 127.0.0.1',
    ].join('\n'),
  );
  const extra = { sshScope: { configFiles: [config], localAddresses: ['127.0.0.1', '192.168.1.50'], homeDir: root } };

  for (const provider of ['Bash', 'exec_command']) {
    for (const command of [
      "ssh ascend 'npu-smi info'",
      'ssh ascend "cd /workspace && python3 train.py"',
      "ssh ascend 'bash -s' <<'EOF'\nnpu-smi info\nEOF\n",
      'ssh -O check ascend',
    ]) {
      const result = decideNativeHookPayload(payload(command, provider, main), { ...options, ...extra });
      assert.equal(result.decision, 'allow', `${provider}: ${command} => ${JSON.stringify(result)}`);
      assert.equal(result.reasonCode, 'remote_ssh_policy_deferred');
      assert.equal(result.target.value, 'ssh://root@ascend:2222');
    }
  }

  const agyAllow = decideAgyNativeHookPayload(
    { toolCall: { name: 'run_command', args: { CommandLine: "ssh ascend 'npu-smi info'" } }, workspacePaths: [main] },
    { ...options, ...extra },
  );
  assert.equal(agyAllow.decision, 'allow', JSON.stringify(agyAllow));

  const direct = decide('ssh direct-remote hostname', main, extra);
  assert.equal(direct.decision, 'allow', JSON.stringify(direct));
  assert.equal(direct.target.value, 'ssh://203.0.113.9:22');
  assert.equal(
    decide('ssh direct-remote hostname', main, {
      sshScope: { configFiles: [config], localAddresses: ['203.0.113.9'], homeDir: root },
    }).decision,
    'allow',
    'harmless local command still runs through local policy when no ControlMaster/ProxyJump is present',
  );
  assert.equal(
    decide("ssh direct-remote 'kill -TERM 4242'", main, {
      sshScope: { configFiles: [config], localAddresses: ['203.0.113.9'], homeDir: root },
    }).decision,
    'deny',
    'alias resolving to a local interface address never gets remote scope',
  );

  for (const deniedCommand of [
    `ssh ascend true > '${runtime}/.env'`,
    'ssh ascend "$(kill -TERM 4242)"',
    'ssh -O exit ascend',
    'ssh -O stop ascend',
    'ssh -O forward ascend',
    'ssh -O check ascend hostname',
    'ssh -O check local-only',
    'ssh -o ControlMaster=auto ascend true',
    'ssh -o ControlPath=~/.ssh/cm-%C ascend true',
    'ssh -S ~/.ssh/cm-%C ascend true',
    'ssh -J jump-ali ascend true',
    'ssh -o ProxyJump=jump-ali ascend true',
    'ssh local-only true',
    "ssh local-only 'kill -TERM 4242'",
    'ssh local-jump true',
    'ssh bad-cm true',
    `ssh loop 'rm -rf ${runtime}/.env'`,
    'ssh loop true',
    `ssh lanback 'rm -rf ${runtime}/.env'`,
    'ssh lanback true',
    'ssh lanback-hop true',
  ]) {
    const result = decide(deniedCommand, runtime, extra);
    assert.equal(result.decision, 'deny', `${deniedCommand} => ${JSON.stringify(result)}`);
  }
});
