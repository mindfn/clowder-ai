import childProcess from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import { basename } from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';

const DISTRIBUTABLE_SCOPE = 'distributable';
const LOCAL_HOSTS = new Set(['localhost', '::1']);
const NETWORK_COMMANDS = new Set(['curl', 'wget', 'ssh', 'scp', 'sftp', 'gh']);

function violation(detail) {
  const error = new Error(`external_resource_violation: ${detail}`);
  error.code = 'CAT_CAFE_PUBLIC_TEST_EXTERNAL_RESOURCE';
  return error;
}

function normalizedHostname(value) {
  return String(value ?? '')
    .trim()
    .replace(/^\[(.*)\]$/, '$1')
    .toLowerCase();
}

export function isLoopbackHostname(value) {
  const hostname = normalizedHostname(value).replace(/\.$/, '');
  return (
    LOCAL_HOSTS.has(hostname) || /^127(?:\.\d{1,3}){3}$/.test(hostname) || /^::ffff:127(?:\.\d{1,3}){3}$/.test(hostname)
  );
}

export function assertDistributableUrl(value, operation = 'network request') {
  let parsed;
  try {
    parsed = value instanceof URL ? value : new URL(String(value));
  } catch {
    throw violation(`${operation} has an unparseable target`);
  }
  if (['file:', 'data:', 'blob:'].includes(parsed.protocol)) return parsed;
  if (['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol) && isLoopbackHostname(parsed.hostname)) {
    return parsed;
  }
  throw violation(`${operation} cannot access non-loopback target ${parsed.origin}`);
}

function urlsIn(values) {
  return values.flatMap((value) => String(value).match(/(?:https?|wss?|file):\/\/[^\s'"`]+/g) ?? []);
}

function shellCommands(command) {
  return String(command)
    .split(/(?:&&|\|\||[;|\n])/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => {
      const withoutAssignments = segment.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S+)\s+)*/, '');
      const match = /^(?:command\s+|env(?:\s+(?:-[^\s]+|[A-Za-z_][A-Za-z0-9_]*=\S+))*\s+)?([^\s]+)/.exec(
        withoutAssignments,
      );
      return match ? { executable: basename(match[1]).toLowerCase(), text: withoutAssignments } : undefined;
    })
    .filter(Boolean);
}

function shellCommandAllowed(command) {
  const text = String(command);
  for (const commandPart of shellCommands(text)) {
    if (['gh', 'ssh', 'scp', 'sftp'].includes(commandPart.executable)) {
      throw violation(`distributable tests cannot execute ${commandPart.executable}`);
    }
    if (['curl', 'wget'].includes(commandPart.executable)) {
      const urls = urlsIn([commandPart.text]);
      if (urls.length === 0) throw violation('network command has no provably loopback target');
      for (const url of urls) assertDistributableUrl(url, 'external command');
    }
  }
}

export function assertDistributableCommand(command, args = []) {
  const executable = basename(String(command)).toLowerCase();
  const normalizedArgs = Array.isArray(args) ? args.map(String) : [];
  if (['sh', 'bash', 'zsh'].includes(executable)) {
    const commandIndex = normalizedArgs.indexOf('-c');
    if (commandIndex >= 0 && normalizedArgs[commandIndex + 1]) {
      shellCommandAllowed(normalizedArgs[commandIndex + 1]);
    }
    return;
  }
  if (executable === 'env') {
    const nestedIndex = normalizedArgs.findIndex((arg) => !arg.startsWith('-') && !arg.includes('='));
    if (nestedIndex >= 0)
      assertDistributableCommand(normalizedArgs[nestedIndex], normalizedArgs.slice(nestedIndex + 1));
    return;
  }
  if (!NETWORK_COMMANDS.has(executable)) return;
  if (['gh', 'ssh', 'scp', 'sftp'].includes(executable)) {
    throw violation(`distributable tests cannot execute ${executable}`);
  }
  const urls = urlsIn(normalizedArgs);
  if (urls.length === 0) throw violation(`${executable} has no provably loopback target`);
  for (const url of urls) assertDistributableUrl(url, executable);
}

function requestTarget(args, protocol) {
  const [first] = args;
  if (typeof first === 'string' || first instanceof URL) return first;
  if (!first || typeof first !== 'object') return undefined;
  if (first.socketPath) return 'unix-socket';
  const host = first.hostname ?? first.host;
  if (!host) return undefined;
  const port = first.port ? `:${first.port}` : '';
  return `${protocol}//${host}${port}${first.path ?? '/'}`;
}

function connectHost(args) {
  const [first, second] = args;
  if (first && typeof first === 'object') return first.host ?? first.hostname ?? 'localhost';
  if (typeof first === 'number') return typeof second === 'string' ? second : 'localhost';
  return undefined;
}

function preserveFunctionProperties(wrapper, original) {
  for (const key of Reflect.ownKeys(original)) {
    if (['length', 'name', 'prototype'].includes(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(original, key);
    if (descriptor) Object.defineProperty(wrapper, key, descriptor);
  }
  return wrapper;
}

function installGuard() {
  if (process.env.CAT_CAFE_PUBLIC_TEST_RESOURCE_SCOPE !== DISTRIBUTABLE_SCOPE) return;

  process.env.GIT_ALLOW_PROTOCOL = 'file';
  const guardImport = `--import=${fileURLToPath(import.meta.url)}`;
  if (!(process.env.NODE_OPTIONS ?? '').split(/\s+/).includes(guardImport)) {
    process.env.NODE_OPTIONS = `${guardImport}${process.env.NODE_OPTIONS ? ` ${process.env.NODE_OPTIONS}` : ''}`;
  }

  if (typeof globalThis.fetch === 'function') {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = function guardedFetch(input, ...args) {
      const target = typeof Request !== 'undefined' && input instanceof Request ? input.url : input;
      assertDistributableUrl(target, 'fetch');
      return originalFetch.call(this, input, ...args);
    };
  }
  if (typeof globalThis.WebSocket === 'function') {
    const OriginalWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = class GuardedWebSocket extends OriginalWebSocket {
      constructor(url, ...args) {
        assertDistributableUrl(url, 'WebSocket');
        super(url, ...args);
      }
    };
  }

  for (const [module, protocol] of [
    [http, 'http:'],
    [https, 'https:'],
  ]) {
    for (const method of ['request', 'get']) {
      const original = module[method];
      module[method] = function guardedRequest(...args) {
        const target = requestTarget(args, protocol);
        if (target === 'unix-socket') return original.apply(this, args);
        if (target) assertDistributableUrl(target, `${protocol}${method}`);
        else throw violation(`${protocol}${method} has no provably loopback target`);
        return original.apply(this, args);
      };
    }
  }

  for (const [module, methods] of [
    [net, ['connect', 'createConnection']],
    [tls, ['connect']],
  ]) {
    for (const method of methods) {
      const original = module[method];
      module[method] = function guardedConnect(...args) {
        const host = connectHost(args);
        if (host !== undefined && !isLoopbackHostname(host)) {
          throw violation(`${method} cannot access non-loopback host ${host}`);
        }
        return original.apply(this, args);
      };
    }
  }

  for (const method of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
    const original = childProcess[method];
    childProcess[method] = preserveFunctionProperties(function guardedFileCommand(command, args, ...rest) {
      assertDistributableCommand(command, Array.isArray(args) ? args : []);
      return original.call(this, command, args, ...rest);
    }, original);
  }
  for (const method of ['exec', 'execSync']) {
    const original = childProcess[method];
    childProcess[method] = preserveFunctionProperties(function guardedShellCommand(command, ...args) {
      shellCommandAllowed(command);
      return original.call(this, command, ...args);
    }, original);
  }
  syncBuiltinESMExports();
}

installGuard();
