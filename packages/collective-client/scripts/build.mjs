import { copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.tsx'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  jsx: 'automatic',
  outfile: 'dist/assets/app.js',
  sourcemap: false,
  minify: false,
  legalComments: 'none',
  external: ['/collective-client/collective-landing-A.png'],
});

await copyFile(
  fileURLToPath(new URL('../assets/collective-landing-A.png', import.meta.url)),
  'dist/assets/collective-landing-A.png',
);
