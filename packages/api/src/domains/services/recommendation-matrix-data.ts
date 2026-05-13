import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import type { ServiceMatrix } from './recommendation-types.js';

const YAML_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'recommendation-matrix.yaml');

interface MatrixFile {
  services: ServiceMatrix;
}

function loadMatrix(): ServiceMatrix {
  const text = readFileSync(YAML_PATH, 'utf-8');
  const parsed = parse(text) as MatrixFile | null;
  if (!parsed || typeof parsed !== 'object' || !parsed.services) {
    throw new Error(`Invalid recommendation matrix at ${YAML_PATH}: missing "services" key`);
  }
  return parsed.services;
}

export const SERVICE_MATRIX: ServiceMatrix = loadMatrix();
