import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

const CONTROL_PATH_TOKENS = new Set(['%', 'C', 'h', 'i', 'j', 'L', 'l', 'n', 'p', 'r', 'u']);

function nearestRealPath(target) {
  let current = target;
  while (true) {
    try {
      return realpathSync(current);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

function parseControlPathTokens(name) {
  const tokens = new Set();
  for (let i = 0; i < name.length; i += 1) {
    if (name[i] !== '%') continue;
    const code = name[i + 1];
    if (!code || !CONTROL_PATH_TOKENS.has(code)) {
      throw new Error('SSH ControlPath contains unsupported token');
    }
    if (code !== '%') tokens.add(code);
    i += 1;
  }
  return tokens;
}

function assertControlPathInsideSshDir(normalized, homeDir) {
  const sshDir = resolve(homeDir, '.ssh');
  if (!normalized.startsWith(`${sshDir}${sep}`)) {
    throw new Error('SSH ControlPath is outside ~/.ssh');
  }
  const parentDir = dirname(normalized);
  if (parentDir.includes('%')) {
    throw new Error('SSH ControlPath parent directory cannot expand tokens');
  }
  const realHome = nearestRealPath(homeDir);
  const realSshDir = nearestRealPath(sshDir);
  if (realSshDir !== join(realHome, '.ssh') && realSshDir !== realHome) {
    throw new Error('SSH ControlPath ~/.ssh resolves outside home');
  }
  const realParent = nearestRealPath(parentDir);
  if (realParent !== realSshDir && !realParent.startsWith(`${realSshDir}${sep}`)) {
    throw new Error('SSH ControlPath resolves outside ~/.ssh');
  }
}

export function auditConfigControlPath(value, homeDir) {
  if (value.toLowerCase() === 'none') return { enabled: false, hasJumpIsolation: true };
  if (!value || /[\s\0$]/.test(value)) throw new Error('unreadable SSH ControlPath');
  const expanded = value.startsWith('~/') ? join(homeDir, value.slice(2)) : value;
  if (!isAbsolute(expanded) || expanded.split(/[\\/]/).includes('..')) {
    throw new Error('SSH ControlPath is outside ~/.ssh');
  }
  const normalized = resolve(expanded);
  assertControlPathInsideSshDir(normalized, homeDir);
  const tokens = parseControlPathTokens(basename(normalized));
  const hasBaseIsolation = tokens.has('C') || (tokens.has('h') && tokens.has('p') && tokens.has('r'));
  if (!hasBaseIsolation) throw new Error('SSH ControlPath is not isolated per target');
  const hasJumpIsolation =
    tokens.has('C') || (tokens.has('h') && tokens.has('p') && tokens.has('r') && tokens.has('j'));
  return { enabled: true, hasJumpIsolation };
}
