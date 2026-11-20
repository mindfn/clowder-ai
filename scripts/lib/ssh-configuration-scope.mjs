import { closeSync, constants, fstatSync, openSync, readdirSync, readSync, realpathSync } from 'node:fs';
import { isIP } from 'node:net';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { shellWords, stripShellComments } from '../native-effect-shell-tokenizer.mjs';
import { auditConfigControlPath } from './ssh-control-path.mjs';

// These options can execute locally, relocate the connection, reuse another
// transport, or introduce local listeners/writes. They are never a remote proof.
const LOCAL_OPTIONS = new Set([
  'proxycommand',
  'proxyjump',
  'localcommand',
  'permitlocalcommand',
  'knownhostscommand',
  'remotecommand',
  'localforward',
  'remoteforward',
  'dynamicforward',
  'tunnel',
  'tunneldevice',
  'controlmaster',
  'controlpath',
  'pkcs11provider',
  'securitykeyprovider',
  'canonicalizehostname',
  'canonicaldomains',
  'userknownhostsfile',
  'globalknownhostsfile',
  'updatehostkeys',
]);
// Values are option-specific: `ProxyCommand no` names a local executable;
// it is not the boolean spelling used by PermitLocalCommand.
const DISABLED = new Map([
  ['proxycommand', new Set(['none'])],
  ['proxyjump', new Set(['none'])],
  ['permitlocalcommand', new Set(['no'])],
  ['controlmaster', new Set(['no'])],
  ['controlpath', new Set(['none'])],
  ['canonicalizehostname', new Set(['no'])],
  ['updatehostkeys', new Set(['no'])],
  ['tunnel', new Set(['no'])],
]);

const CONTROL_MASTER_VALUES = new Set(['no', 'auto', 'yes']);

export function sshOptionIsLocal(name, value) {
  name = name.toLowerCase();
  return LOCAL_OPTIONS.has(name) && !DISABLED.get(name)?.has(value.toLowerCase());
}

function parseProxyJump(value) {
  if (value.toLowerCase() === 'none') return [];
  if (!value || /[\s\0]/.test(value)) throw new Error('unreadable SSH ProxyJump');
  const hops = value.split(',');
  if (hops.length === 0 || hops.length > 4) throw new Error('SSH ProxyJump exceeds bound');
  return hops.map((hop) => {
    const match = /^(?:([\w.-]+)@)?([A-Za-z0-9.-]+)(?::(\d+))?$/.exec(hop);
    if (!match) throw new Error('unreadable SSH ProxyJump hop');
    if (match[3] !== undefined && (Number(match[3]) < 1 || Number(match[3]) > 65535)) {
      throw new Error('SSH ProxyJump port is unknown');
    }
    return match[2];
  });
}

function globPattern(pattern) {
  return new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replaceAll('*', '.*')
      .replaceAll('?', '.')}$`,
    'i',
  );
}

function hostMatches(patterns, host) {
  let positive = false;
  for (const pattern of patterns) {
    // systemd uses unix/* and unix%* Host patterns for its local transports.
    // Slash and percent are literal pattern data here, never an executable or
    // a token expansion. Match first; only the active block's options apply.
    if (!/^[!\w.*?:%/-]+$/.test(pattern)) throw new Error('unreadable SSH Host pattern');
    const negative = pattern.startsWith('!');
    if (!globPattern(negative ? pattern.slice(1) : pattern).test(host)) continue;
    if (negative) return false;
    positive = true;
  }
  return positive;
}

function includePaths(value, prefix, homeDir) {
  const path = value.startsWith('~/') ? join(homeDir, value.slice(2)) : isAbsolute(value) ? value : join(prefix, value);
  if (/[$%`{}[\]]/.test(path) || /[*?]/.test(dirname(path))) throw new Error('unreadable SSH Include');
  if (!/[*?]/.test(path)) return [path];
  let names;
  try {
    names = readdirSync(dirname(path));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  if (names.length > 256) throw new Error('SSH Include exceeds bound');
  return names
    .filter((name) => globPattern(basename(path)).test(name))
    .sort()
    .map((name) => join(dirname(path), name));
}

function configurationBytes(path) {
  let fd;
  try {
    fd = openSync(realpathSync(path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 65536) throw new Error('SSH config is not a bounded ordinary file');
    const buffer = Buffer.alloc(65537);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > 65536) throw new Error('SSH config grew beyond its bound');
    return buffer.toString('utf8', 0, length);
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function auditHostName(value, state) {
  if (isIP(state.host) !== 0) {
    if (value !== state.host) throw new Error('SSH config changes local execution/target');
    return;
  }
  if (!/^[A-Za-z0-9.:-]+$/.test(value)) throw new Error('SSH config changes local execution/target');
  if (state.hostname !== undefined && state.hostname !== value) {
    throw new Error('SSH config changes local execution/target');
  }
  state.hostname = value;
}

function auditProxyJump(value, state) {
  const hops = parseProxyJump(value);
  if (state.proxyJumps !== undefined && JSON.stringify(state.proxyJumps) !== JSON.stringify(hops)) {
    throw new Error('SSH config changes local execution/target');
  }
  state.proxyJumps = hops;
}

function auditControlMaster(value, state) {
  const normalized = value.toLowerCase();
  if (!CONTROL_MASTER_VALUES.has(normalized)) throw new Error('SSH config changes local execution/target');
  if (normalized !== 'no') state.hasControlMaster = true;
}

function auditPort(value, state) {
  if (state.port !== undefined) return;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw new Error('SSH port is unknown');
  state.port = Number(value);
}

function auditProxyCommand(value, state) {
  if (value.toLowerCase() !== 'none') throw new Error('SSH config changes local execution/target');
  state.sawProxyCommand = true;
}

function auditControlPathOption(value, state) {
  const audited = auditConfigControlPath(value, state.homeDir);
  if (!audited.enabled) return;
  state.hasControlMaster = true;
  if (!audited.hasJumpIsolation) state.controlPathLacksJumpIsolation = true;
}

function auditUser(value, state) {
  if (!/^[\w.-]+$/.test(value)) throw new Error('SSH user is unknown');
  if (state.user === undefined) state.user = value;
}

/** Read configuration, never `ssh -G`: Match exec can run even during that query.
 * This recognizes Host/Include only; unmodelled Match or relocation is unknown.
 * All files remain inputs; no identity contents or SSH command is read/executed.
 */
function auditOption(key, value, state) {
  if (key === 'hostname') return auditHostName(value, state);
  if (key === 'proxyjump') return auditProxyJump(value, state);
  if (key === 'proxycommand') return auditProxyCommand(value, state);
  if (key === 'controlmaster') return auditControlMaster(value, state);
  if (key === 'controlpath') return auditControlPathOption(value, state);
  if (sshOptionIsLocal(key, value)) throw new Error('SSH config changes local execution/target');
  if (key === 'user') return auditUser(value, state);
  if (key === 'port') auditPort(value, state);
}

function readDirective(words, context, prefix, depth, state) {
  const key = words[0].value.toLowerCase();
  const values = words.slice(1).map((word) => word.value);
  if (key === 'host') {
    context.active = hostMatches(values, state.host);
    return;
  }
  if (key === 'match') throw new Error('SSH Match execution scope is unknown');
  if (!context.active) return;
  if (key !== 'include') {
    auditOption(key, values.join(' '), state);
    return;
  }
  // Host state inside an Include is local to that file. Options remain
  // shared, but its last Host block must not disable the parent's checks.
  for (const value of values)
    for (const file of includePaths(value, prefix, state.homeDir))
      readConfiguration(file, { ...context }, prefix, depth + 1, state);
}

function readConfiguration(path, context, prefix, depth, state) {
  if (depth > 4 || state.visited.has(path) || state.visited.size >= 16) throw new Error('SSH config recursion');
  state.visited.add(path);
  const source = configurationBytes(path);
  state.bytes += Buffer.byteLength(source);
  if (state.bytes > 262144) throw new Error('SSH config exceeds bound');
  for (const line of source.split(/\r?\n/)) {
    const text = stripShellComments(line).trim();
    if (!text) continue;
    const words = shellWords(text.replace(/^(\w+)\s*=\s*/, '$1 '));
    if (!words?.length) throw new Error('unreadable SSH config');
    readDirective(words, context, prefix, depth, state);
  }
}

function collectHopHosts(hopScopes, proxyJumps) {
  const hosts = [];
  for (let i = 0; i < hopScopes.length; i += 1) {
    const scope = hopScopes[i];
    if (i > 0) {
      if (scope.entryHost) hosts.push(scope.entryHost);
      hosts.push(scope.hostname ?? proxyJumps[i]);
    } else if (scope.hasProxyJump) {
      hosts.push(scope.hostname ?? proxyJumps[i]);
    }
    if (scope.hopHosts?.length) hosts.push(...scope.hopHosts);
  }
  return hosts;
}

function auditProxyJumpChain(host, proxyJumps, files, homeDir, jumpDepth, visitedHosts) {
  const nextVisited = new Set(visitedHosts);
  nextVisited.add(host);
  const hopScopes = proxyJumps.map((hopHost) =>
    sshConfigurationScope(hopHost, files, {
      homeDir,
      _jumpDepth: jumpDepth + 1,
      _visitedHosts: nextVisited,
    }),
  );
  const failedHop = hopScopes.find((scope) => !scope.complete);
  if (failedHop) return { ok: false, failedHop };
  const firstHop = hopScopes[0];
  return {
    ok: true,
    entryHost: firstHop.entryHost ?? firstHop.hostname ?? proxyJumps[0],
    hopHosts: collectHopHosts(hopScopes, proxyJumps),
    hasControlMaster: hopScopes.some((scope) => scope.hasControlMaster),
  };
}

function buildScopeResult(state, jumpResult) {
  const result = { complete: true, port: state.port ?? 22 };
  if (state.hostname !== undefined) result.hostname = state.hostname;
  if (state.user !== undefined) result.user = state.user;
  if (jumpResult) {
    result.entryHost = jumpResult.entryHost;
    if (jumpResult.hopHosts.length) result.hopHosts = jumpResult.hopHosts;
    result.hasProxyJump = true;
  }
  if (state.hasControlMaster || jumpResult?.hasControlMaster) result.hasControlMaster = true;
  return result;
}

export function sshConfigurationScope(host, files, options = {}) {
  const homeDir = options.homeDir ?? homedir();
  const configFiles = files ?? [join(homeDir, '.ssh/config'), '/etc/ssh/ssh_config'];
  const jumpDepth = options._jumpDepth ?? 0;
  const visitedHosts = options._visitedHosts ?? new Set();
  if (jumpDepth > 4 || visitedHosts.has(host)) return { complete: false, reason: 'SSH ProxyJump recursion' };
  const state = {
    host,
    homeDir,
    visited: new Set(),
    bytes: 0,
    port: undefined,
    hostname: undefined,
    user: undefined,
    proxyJumps: undefined,
    sawProxyCommand: false,
    hasControlMaster: false,
    controlPathLacksJumpIsolation: false,
  };
  try {
    for (const file of configFiles) readConfiguration(file, { active: true }, dirname(file), 0, state);
    if (!state.proxyJumps?.length) return buildScopeResult(state, null);
    if (state.sawProxyCommand) throw new Error('SSH ProxyCommand conflicts with ProxyJump');
    if (state.controlPathLacksJumpIsolation) throw new Error('SSH ControlPath with ProxyJump must isolate jump host');
    const jumpResult = auditProxyJumpChain(host, state.proxyJumps, configFiles, homeDir, jumpDepth, visitedHosts);
    return jumpResult.ok ? buildScopeResult(state, jumpResult) : jumpResult.failedHop;
  } catch (error) {
    return { complete: false, reason: error.code ?? error.message };
  }
}
