import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(scriptDir, '..');

const FILES = [
  {
    source: path.join(packageDir, 'src/domains/services/recommendation-matrix.yaml'),
    target: path.join(packageDir, 'dist/domains/services/recommendation-matrix.yaml'),
  },
];

export async function copyServicesData() {
  for (const { source, target } of FILES) {
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target);
  }
  return FILES.length;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await copyServicesData();
}
