import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { publicCollectiveAvatar } from '../dist/domains/plugin/builtin-runtime/collective-public-avatar.js';

test('registered local avatar becomes a small portable image, while traversal is rejected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'collective-avatar-'));
  try {
    const avatars = join(root, 'avatars');
    await mkdir(avatars);
    await writeFile(
      join(avatars, 'sol.png'),
      await sharp({ create: { width: 400, height: 400, channels: 4, background: '#665544' } })
        .png()
        .toBuffer(),
    );
    const image = await publicCollectiveAvatar('/avatars/sol.png', { avatars, uploads: root });
    assert.match(image, /^data:image\/webp;base64,[A-Za-z0-9+/=]+$/);
    assert.ok(image.length < 1_200);
    assert.equal(await publicCollectiveAvatar('/avatars/../private.png', { avatars, uploads: root }), undefined);
    assert.equal(
      await publicCollectiveAvatar('http://127.0.0.1:3011/avatars/sol.png', { avatars, uploads: root }),
      undefined,
    );
    await writeFile(join(root, 'secret.png'), 'not an avatar');
    await symlink(join(root, 'secret.png'), join(avatars, 'link.png'));
    assert.equal(await publicCollectiveAvatar('/avatars/link.png', { avatars, uploads: root }), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the detailed Luna avatar is adaptively compressed instead of disappearing at the wire limit', async () => {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const image = await publicCollectiveAvatar('/avatars/family/codex6-luna.png', {
    avatars: join(repositoryRoot, 'packages/web/public/avatars'),
    uploads: join(repositoryRoot, 'packages/web/public/uploads'),
  });
  assert.match(image, /^data:image\/webp;base64,[A-Za-z0-9+/=]+$/);
  assert.ok(image.length <= 1_200, `expected bounded avatar, got ${image.length} bytes`);
});
