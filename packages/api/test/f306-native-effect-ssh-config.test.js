import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { sshConfigurationScope } from '../../../scripts/lib/ssh-configuration-scope.mjs';
import { systemSshRunnerInputs } from './helpers/system-ssh-runner-inputs.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ssh-config-scope-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('an included symlinked crypto file is a read input; an included ProxyCommand remains local', (t) => {
  const root = fixture(t),
    config = join(root, 'config'),
    source = join(root, 'source'),
    link = join(root, 'crypto');
  writeFileSync(config, `Host *\n Include ${link}\n`);
  writeFileSync(source, 'Ciphers aes256-gcm@openssh.com\n');
  symlinkSync(source, link);
  assert.equal(sshConfigurationScope('203.0.113.8', [config]).complete, true);
  writeFileSync(source, 'ProxyCommand touch /tmp/not-executed\n');
  assert.equal(sshConfigurationScope('203.0.113.8', [config]).complete, false);
});

test('unknown includes, cycles, and non-regular files cannot be silently treated as empty configuration', (t) => {
  const root = fixture(t),
    config = join(root, 'config');
  for (const content of [`Include ${config}\n`, 'Include %h/missing\n', 'Match exec true\n']) {
    writeFileSync(config, content);
    assert.equal(sshConfigurationScope('203.0.113.8', [config]).complete, false);
  }
  const fifo = join(root, 'fifo');
  execFileSync('mkfifo', [fifo]);
  assert.equal(sshConfigurationScope('203.0.113.8', [fifo]).complete, false, 'must not block opening FIFO');
});

test('Host negation and a literal destination reject local relocation while preserving unrelated aliases', (t) => {
  const root = fixture(t),
    config = join(root, 'config');
  writeFileSync(config, 'Host * !203.0.113.8\n ProxyCommand false\nHost 203.0.113.?\n Port 2222\n');
  assert.deepEqual(sshConfigurationScope('203.0.113.8', [config]), { complete: true, port: 2222 });
  writeFileSync(config, 'Host 203.0.113.*\n HostName 127.0.0.1\n');
  assert.equal(sshConfigurationScope('203.0.113.8', [config]).complete, false);
});

test('disabling values belong to each SSH option; a command named no or false is still local execution', (t) => {
  const root = fixture(t),
    config = join(root, 'config');
  for (const directive of ['ProxyCommand no', 'KnownHostsCommand false', 'LocalCommand no']) {
    writeFileSync(config, `Host *\n ${directive}\n`);
    assert.equal(sshConfigurationScope('203.0.113.8', [config]).complete, false, directive);
  }
  writeFileSync(config, 'Host *\n ProxyCommand none\n PermitLocalCommand no\n ControlMaster no\n');
  assert.equal(sshConfigurationScope('203.0.113.8', [config]).complete, true);
});

test('an Include Host block cannot disable local admission in its active parent', (t) => {
  const root = fixture(t),
    config = join(root, 'config'),
    included = join(root, 'included');
  writeFileSync(included, 'Host unrelated.example\n Port 2266\n');
  writeFileSync(config, `Host *\n Include ${included}\n ProxyCommand kill -TERM 4242\n`);
  assert.equal(sshConfigurationScope('203.0.113.8', [config]).complete, false);
  writeFileSync(config, `Host *\n Include ${included}\n Port 2255\n`);
  assert.deepEqual(sshConfigurationScope('203.0.113.8', [config]), { complete: true, port: 2255 });
});

test('unrelated systemd SSH transport patterns are data, while matching proxy blocks stay denied', (t) => {
  const root = fixture(t),
    config = join(root, 'config'),
    transport = join(root, '20-systemd-ssh-proxy.conf');
  // systemd's distributed ssh_config fragment: slash and percent are literal
  // Host pattern data, not shell syntax or percent expansion in this directive.
  writeFileSync(
    transport,
    [
      'Host .host machine/.host',
      ' ProxyCommand /usr/lib/systemd/systemd-ssh-proxy unix/run/ssh-unix-local/socket %p',
      'Host unix/* unix%* vsock/* vsock%* vsock-mux/* vsock-mux%* machine/* machine%*',
      ' User root',
      ' ProxyCommand /usr/lib/systemd/systemd-ssh-proxy %h %p',
      ' ProxyUseFdpass yes',
      ' CheckHostIP no',
    ].join('\n'),
  );
  writeFileSync(config, `Include ${transport}\nHost *\n Port 22\n`);
  assert.deepEqual(sshConfigurationScope('203.0.113.8', [config]), { complete: true, port: 22 });
  for (const host of [
    '.host',
    'machine/.host',
    'unix/run/ssh/socket',
    'unix%run%ssh%socket',
    'vsock/7:22',
    'machine/test',
  ])
    assert.equal(sshConfigurationScope(host, [config]).complete, false, host);
  writeFileSync(config, `Include ${transport}\nHost *\n ProxyCommand kill -TERM 4242\n`);
  assert.equal(sshConfigurationScope('203.0.113.8', [config]).complete, false, 'active proxy remains local');
});

test('runner diagnostics capture only bounded system inputs and never follow an extra Include', (t) => {
  const root = fixture(t);
  mkdirSync(join(root, 'ssh_config.d'));
  writeFileSync(join(root, 'ssh_config'), `Include ${root}/ssh_config.d/*.conf\n`);
  writeFileSync(join(root, 'ssh_config.d', '20-local.conf'), 'Host unix/* unix%*\n ProxyCommand false\n');
  const result = systemSshRunnerInputs(root);
  assert.deepEqual(result.scope, { complete: true, port: 22 });
  assert.equal(result.files.length, 2);
  writeFileSync(join(root, 'ssh_config'), 'Include ~/.ssh/config\n');
  assert.equal(systemSshRunnerInputs(root).scope.reason, 'diagnostic_include_out_of_scope');
});

test('host aliases resolve HostName/User, recursively audit ProxyJump, and allow isolated ~/.ssh ControlPath', (t) => {
  const root = fixture(t),
    config = join(root, 'config');
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
    ].join('\n'),
  );
  assert.deepEqual(sshConfigurationScope('ascend', [config], { homeDir: root }), {
    complete: true,
    port: 2222,
    hostname: '127.0.0.1',
    user: 'root',
    entryHost: '203.0.113.8',
    hasProxyJump: true,
    hasControlMaster: true,
  });

  writeFileSync(
    config,
    [
      'Host hop1',
      '  HostName 203.0.113.10',
      'Host hop2',
      '  HostName 10.0.0.5',
      'Host deep',
      '  HostName 127.0.0.1',
      '  ProxyJump hop1,root@hop2:2200',
      `  ControlPath ${join(root, '.ssh', 'cm-%C')}`,
      'Host deep-tokens',
      '  HostName 127.0.0.1',
      '  ProxyJump hop1',
      '  ControlPath ~/.ssh/cm-%h-%p-%r-%j',
      'Host direct-tokens',
      '  HostName 203.0.113.11',
      '  ControlPath ~/.ssh/cm-%h-%p-%r',
    ].join('\n'),
  );
  assert.deepEqual(sshConfigurationScope('deep', [config], { homeDir: root }), {
    complete: true,
    port: 22,
    hostname: '127.0.0.1',
    entryHost: '203.0.113.10',
    hopHosts: ['10.0.0.5'],
    hasProxyJump: true,
    hasControlMaster: true,
  });
  assert.equal(sshConfigurationScope('deep-tokens', [config], { homeDir: root }).complete, true);
  assert.equal(sshConfigurationScope('direct-tokens', [config], { homeDir: root }).complete, true);
});

test('Include ~/ resolves relative to the configured homeDir', (t) => {
  const root = fixture(t),
    sshDir = join(root, '.ssh'),
    config = join(root, 'config'),
    extra = join(sshDir, 'extra.conf');
  mkdirSync(sshDir);
  writeFileSync(config, 'Host ascend\n  HostName 203.0.113.8\n  Include ~/.ssh/extra.conf\n');
  writeFileSync(extra, 'Port 2229\n');
  assert.deepEqual(sshConfigurationScope('ascend', [config], { homeDir: root }), {
    complete: true,
    port: 2229,
    hostname: '203.0.113.8',
  });
  writeFileSync(extra, 'ProxyCommand kill -TERM 4242\n');
  assert.equal(sshConfigurationScope('ascend', [config], { homeDir: root }).complete, false);
});

test('unsafe ProxyJump chains, conflicting HostName, and unisolated/out-of-ssh ControlPath fail closed', (t) => {
  const root = fixture(t),
    config = join(root, 'config');
  const unsafeConfigs = [
    // P1: ProxyCommand none suppresses ProxyJump in OpenSSH (target layer, both orders)
    'Host ascend\n  ProxyCommand none\n  ProxyJump 8.8.8.8\n  HostName 127.0.0.1\n',
    'Host ascend\n  ProxyJump 8.8.8.8\n  ProxyCommand none\n  HostName 127.0.0.1\n',
    // P1: ProxyCommand none suppresses ProxyJump in a hop scope
    'Host jump-loop\n  ProxyCommand none\n  ProxyJump 8.8.8.8\n  HostName 127.0.0.1\nHost ascend\n  HostName 127.0.0.1\n  ProxyJump jump-loop\n',
    // ProxyJump target hides a local executor
    'Host jump-bad\n  HostName 203.0.113.8\n  ProxyCommand kill -TERM 4242\nHost ascend\n  HostName 127.0.0.1\n  ProxyJump jump-bad\n',
    // Second hop hides a local executor
    'Host hop1\n  HostName 203.0.113.8\nHost hop2\n  HostName 10.0.0.5\n  LocalCommand kill -TERM 4242\nHost ascend\n  HostName 127.0.0.1\n  ProxyJump hop1,hop2\n',
    // ProxyJump cycle
    'Host a\n  ProxyJump b\nHost b\n  ProxyJump a\n',
    // Malformed ProxyJump syntax
    'Host ascend\n  ProxyJump "jump-ali -o ProxyCommand=false"\n',
    // Conflicting HostName across active blocks
    'Host ascend\n  HostName 203.0.113.8\nHost *\n  HostName 127.0.0.1\n',
    // ControlPath outside ~/.ssh
    'Host ascend\n  HostName 203.0.113.8\n  ControlMaster auto\n  ControlPath /tmp/cm-%C\n',
    // ControlPath traversal out of ~/.ssh
    'Host ascend\n  HostName 203.0.113.8\n  ControlMaster auto\n  ControlPath ~/.ssh/../.env-%C\n',
    // Relative ControlPath
    'Host ascend\n  HostName 203.0.113.8\n  ControlMaster auto\n  ControlPath cm-%C\n',
    // ControlPath without target-isolation tokens
    'Host ascend\n  HostName 203.0.113.8\n  ControlMaster auto\n  ControlPath ~/.ssh/shared.sock\n',
    // Escaped %%C is literal percent, not %C isolation token
    'Host ascend\n  HostName 203.0.113.8\n  ControlMaster auto\n  ControlPath ~/.ssh/cm-%%C\n',
    // P2-2: ControlPath runtime environment expansion or unsupported path-injecting tokens
    // biome-ignore lint/suspicious/noTemplateCurlyInString: OpenSSH ControlPath ${ENV} expansion literal
    'Host ascend\n  HostName 203.0.113.8\n  ControlMaster auto\n  ControlPath ~/.ssh/${CM_DIR}/cm-%C\n',
    'Host ascend\n  HostName 203.0.113.8\n  ControlMaster auto\n  ControlPath ~/.ssh/cm-$USER-%C\n',
    'Host ascend\n  HostName 203.0.113.8\n  ControlMaster auto\n  ControlPath ~/.ssh/cm-%d-%C\n',
    'Host ascend\n  HostName 203.0.113.8\n  ControlMaster auto\n  ControlPath ~/.ssh/cm-%k-%C\n',
    'Host ascend\n  HostName 203.0.113.8\n  ControlMaster auto\n  ControlPath ~/.ssh/cm-%C%\n',
    // P3-1: ProxyJump with %h-%p-%r lacks %j jump-host isolation (either directive order)
    'Host jump\n  HostName 203.0.113.8\nHost ascend\n  HostName 127.0.0.1\n  ProxyJump jump\n  ControlPath ~/.ssh/cm-%h-%p-%r\n',
    'Host jump\n  HostName 203.0.113.8\nHost ascend\n  HostName 127.0.0.1\n  ControlPath ~/.ssh/cm-%h-%p-%r\n  ProxyJump jump\n',
    // P3-2: ControlMaster ask/autoask can invoke local ssh-askpass(1)
    'Host ascend\n  HostName 203.0.113.8\n  ControlMaster ask\n',
    'Host ascend\n  HostName 203.0.113.8\n  ControlMaster autoask\n',
    // Unknown ControlMaster value
    'Host ascend\n  HostName 203.0.113.8\n  ControlMaster bogus\n',
  ];
  for (const content of unsafeConfigs) {
    writeFileSync(config, content);
    const host = content.includes('Host a\n') ? 'a' : 'ascend';
    assert.equal(sshConfigurationScope(host, [config], { homeDir: root }).complete, false, content);
  }

  // Symlink escape inside ~/.ssh pointing outside ~/.ssh must fail closed
  const sshDir = join(root, '.ssh');
  const outside = join(root, 'outside');
  mkdirSync(sshDir);
  mkdirSync(outside);
  symlinkSync(outside, join(sshDir, 'escape'));
  writeFileSync(
    config,
    'Host ascend\n  HostName 203.0.113.8\n  ControlMaster auto\n  ControlPath ~/.ssh/escape/cm-%C\n',
  );
  assert.equal(sshConfigurationScope('ascend', [config], { homeDir: root }).complete, false);
});
