#!/usr/bin/env node
// Host-only private Task PreToolUse composition. Ordinary hooks keep their existing entrypoint.
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { decideNativeHookPayload } from './native-effect-target-guard.mjs';

function admissionCredentials(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw Error('missing admission file');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.size > 8192 ||
      (stat.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid())
    )
      throw Error('unsafe admission file');
    const value = JSON.parse(readFileSync(fd, 'utf8'));
    if (
      !value ||
      Object.keys(value).sort().join(',') !== 'apiUrl,callbackToken,invocationId' ||
      !['apiUrl', 'invocationId', 'callbackToken'].every(
        (k) => typeof value[k] === 'string' && value[k].length > 0 && value[k].length < 2048,
      )
    )
      throw Error('invalid admission file');
    const origin = new URL(value.apiUrl);
    if (
      !['http:', 'https:'].includes(origin.protocol) ||
      !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) ||
      origin.username ||
      origin.password ||
      origin.pathname !== '/' ||
      origin.search ||
      origin.hash
    )
      throw Error('invalid Host origin');
    return { ...value, url: new URL('/api/callbacks/native-turn-admission?scope=plugin_task', origin) };
  } finally {
    closeSync(fd);
  }
}
function deny() {
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Host Task effect admission denied',
      },
    })}\n`,
  );
}
try {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 262144) throw Error('hook input too large');
  }
  const decision = decideNativeHookPayload(JSON.parse(input));
  if (decision.decision !== 'allow') throw Error('protected effect');
  const c = admissionCredentials(process.argv[2]);
  const response = await fetch(c.url, {
    method: 'GET',
    headers: { 'x-invocation-id': c.invocationId, 'x-callback-token': c.callbackToken },
    redirect: 'error',
    signal: AbortSignal.timeout(3000),
  });
  if (response.status !== 204) throw Error('Task admission refused');
} catch {
  deny();
}
