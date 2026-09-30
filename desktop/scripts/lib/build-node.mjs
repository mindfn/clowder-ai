import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function nodeInfo() {
  return { version: process.version, abi: process.versions.modules, platform: process.platform, arch: process.arch };
}

function versionParts(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`Invalid stable Node version: ${version}`);
  return match.slice(1).map(Number);
}

// engines.node currently declares a comparator range. Reject unknown syntax
// rather than silently treating an unparsed future constraint as compatible.
export function satisfiesEngine(version, range) {
  const actual = versionParts(version);
  if (typeof range !== 'string' || !range.trim()) throw new Error('Missing engines.node');
  return range
    .trim()
    .split(/\s+/)
    .map((token) => {
      const match = /^(>=|<=|>|<|=)?(\d+)\.(\d+)\.(\d+)$/.exec(token);
      if (!match) throw new Error(`Unsupported engines.node range: ${range}`);
      const wanted = match.slice(2).map(Number);
      const index = actual.findIndex((part, i) => part !== wanted[i]);
      const diff = index < 0 ? 0 : actual[index] - wanted[index];
      switch (match[1] || '=') {
        case '>=':
          return diff >= 0;
        case '<=':
          return diff <= 0;
        case '>':
          return diff > 0;
        case '<':
          return diff < 0;
        default:
          return diff === 0;
      }
    })
    .every(Boolean);
}

export function validateNode(info, { engine, platform, arch, builtWith }) {
  if (!satisfiesEngine(info.version, engine))
    throw new Error(`Node ${info.version} does not satisfy engines.node ${engine}`);
  if (info.platform !== platform || info.arch !== arch) {
    throw new Error(`Node target ${info.platform}/${info.arch} does not match ${platform}/${arch}`);
  }
  if (!/^\d+$/.test(info.abi)) throw new Error(`Invalid Node ABI: ${info.abi}`);
  if (builtWith && (info.version !== builtWith.version || info.abi !== builtWith.abi)) {
    throw new Error(
      `Bundled Node ${info.version}/ABI ${info.abi} differs from build ${builtWith.version}/ABI ${builtWith.abi}`,
    );
  }
  return info;
}

export function engineAt(root) {
  return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).engines?.node;
}

export function probeNode(executable, timeout = 15000) {
  return JSON.parse(
    execFileSync(
      executable,
      [
        '-p',
        'JSON.stringify({version:process.version,abi:process.versions.modules,platform:process.platform,arch:process.arch})',
      ],
      { encoding: 'utf8', timeout },
    ),
  );
}

// Run against deployed/installed files with the bundled executable. In-memory
// SQLite only; no Redis, user profile, persistent DB or running service access.
export function smokeNativeModules(executable, apiDir, timeout = 30000) {
  const script = `
    const fs = require('node:fs');
    const path = require('node:path');
    const { createRequire } = require('node:module');
    const api = fs.realpathSync(process.argv[1]);
    const requireApi = createRequire(path.join(api, 'package.json'));
    const modules = ['better-sqlite3', 'sqlite-vec', 'node-pty', 'sharp'];
    for (const name of modules) {
      const entry = fs.realpathSync(requireApi.resolve(name));
      if (!entry.startsWith(path.join(api, 'node_modules') + path.sep)) {
        throw new Error(name + ' resolved outside the deployed API: ' + entry);
      }
    }
    const db = new (requireApi('better-sqlite3'))(':memory:');
    try {
      requireApi('sqlite-vec').load(db);
      console.log('sqlite/vec:', db.prepare('select vec_version() as v').get().v);
    } finally { db.close(); }
    requireApi('node-pty');
    requireApi('sharp')({create:{width:1,height:1,channels:3,background:'white'}})
      .png().toBuffer().then(() => console.log('native-smoke: OK'))
      .catch(error => { console.error(error); process.exitCode = 1; });
  `;
  return execFileSync(executable, ['-e', script, path.resolve(apiDir)], { encoding: 'utf8', timeout });
}
