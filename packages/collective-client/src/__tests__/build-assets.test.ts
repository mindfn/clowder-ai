import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

it('builds and serves the distributable client without private docs', async () => {
  const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'collective-client-build-'));
  const fixturePackage = join(fixtureRoot, 'packages', 'collective-client');
  try {
    await cp(packageRoot, fixturePackage, {
      recursive: true,
      filter: (source) => !['node_modules', 'dist'].includes(basename(source)),
    });
    await cp(join(packageRoot, '../../tsconfig.base.json'), join(fixtureRoot, 'tsconfig.base.json'));
    const sharedStyles = join(fixtureRoot, 'packages/web/src/app');
    await mkdir(sharedStyles, { recursive: true });
    for (const filename of ['theme-tokens.css', 'console-tokens.css']) {
      await cp(join(packageRoot, '../web/src/app', filename), join(sharedStyles, filename));
    }
    await symlink(join(packageRoot, '../../node_modules'), join(fixtureRoot, 'node_modules'), 'dir');
    await symlink(join(packageRoot, 'node_modules'), join(fixturePackage, 'node_modules'), 'dir');

    execFileSync('pnpm', ['run', 'build'], { cwd: fixturePackage, stdio: 'inherit', timeout: 60_000 });

    const serverPath = join(fixturePackage, 'dist/server.js');
    const server = (await import(pathToFileURL(serverPath).href)) as typeof import('../server.js');
    expect(server.collectiveClientHtml()).toContain('/collective-client/app.js');
    await expect(readFile(join(fixturePackage, 'dist/server.d.ts'), 'utf8')).resolves.toContain(
      'resolveCollectiveClientAsset',
    );
    const landing = server.resolveCollectiveClientAsset('/collective-client/collective-landing-A.png');
    expect(landing.contentType).toBe('image/png');
    expect(await readFile(landing.path)).toEqual(
      await readFile(join(fixturePackage, 'assets/collective-landing-A.png')),
    );
    for (const pathname of ['/collective-client/app.js', '/collective-client/app.css']) {
      const asset = server.resolveCollectiveClientAsset(pathname);
      expect((await readFile(asset.path)).length).toBeGreaterThan(0);
    }
    const css = server.resolveCollectiveClientAsset('/collective-client/app.css');
    expect(await readFile(css.path, 'utf8')).toContain('/collective-client/collective-landing-A.png');
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}, 90_000);
