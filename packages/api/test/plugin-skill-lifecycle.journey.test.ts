import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { pluginSkillLifecycleFixture } from './helpers/plugin-skill-lifecycle-fixture.js';

test('real Manager install → enable with conflict → choose source → restart → uninstall → reinstall', async () => {
  const f = await pluginSkillLifecycleFixture();
  try {
    let current = (await f.manager.getLocal(f.pluginId)).plugin;
    await f.manager.setEnabled(f.pluginId, { enabled: true, expectedRevision: current.lifecycleRevision! });
    current = (await f.manager.getLocal(f.pluginId)).plugin;
    assert.equal(current.activationFailed, undefined);
    assert.equal(current.intent, 'enabled');
    assert.equal(current.skillConflicts?.length, 1);
    assert.equal(current.skillConflicts![0].mountPointId, 'codex');
    assert.equal(await readFile(join(f.root, '.claude/skills/guide/SKILL.md'), 'utf8'), '# Fixture plugin guide\n');
    const result = await f.manager.resolveSkillConflict(f.pluginId, {
      ...current.skillConflicts![0],
      expectedRevision: current.lifecycleRevision!,
    });
    assert.equal(
      await readFile(join(f.root, result.backupPath, 'user.md'), 'utf8'),
      'User-owned content must survive.',
    );
    current = (await f.manager.getLocal(f.pluginId)).plugin;
    assert.deepEqual(current.skillConflicts, []);
    await f.manager.restart(f.pluginId, { expectedRevision: current.lifecycleRevision! });
    current = (await f.manager.getLocal(f.pluginId)).plugin;
    assert.equal(current.activationFailed, undefined);
    assert.deepEqual(current.skillConflicts, []);
    await f.manager.uninstall(f.pluginId, { expectedRevision: current.lifecycleRevision! });
    assert.equal(
      await readFile(join(f.root, result.backupPath, 'user.md'), 'utf8'),
      'User-owned content must survive.',
    );
    await f.install();
    current = (await f.manager.getLocal(f.pluginId)).plugin;
    await f.manager.setEnabled(f.pluginId, { enabled: true, expectedRevision: current.lifecycleRevision! });
    current = (await f.manager.getLocal(f.pluginId)).plugin;
    assert.equal(current.intent, 'enabled');
    assert.equal(current.activationFailed, undefined);
    assert.deepEqual(current.skillConflicts, []);
  } finally {
    await f.close();
  }
});
