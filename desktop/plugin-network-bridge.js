const crypto = require('node:crypto');
const http = require('node:http');

const REQUEST_MAX_BYTES = 4 * 1024;
const CATALOG_MAX_BYTES = 256 * 1024;
const PACKAGE_MAX_BYTES = 32 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const LOOPBACK_HOST = '127.0.0.1';

function targetPolicy(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) return null;
  if (
    url.hostname === 'raw.githubusercontent.com' &&
    (url.pathname === '/zts212653/clowder-ai-plugins/main/catalog/catalog.json' ||
      url.pathname === '/zts212653/clowder-ai-plugins/main/catalog/initial-plugins.json')
  ) {
    return { url, maxBytes: CATALOG_MAX_BYTES };
  }
  if (url.hostname === 'registry.npmjs.org' && url.pathname.endsWith('.tgz')) {
    return { url, maxBytes: PACKAGE_MAX_BYTES };
  }
  return null;
}

async function readRequestJson(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.byteLength;
    if (total > REQUEST_MAX_BYTES) throw new Error('REQUEST_TOO_LARGE');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
  } catch {
    throw new Error('INVALID_JSON');
  }
}

async function pipeBoundedResponse(source, response, maxBytes) {
  const declared = source.headers.get('content-length');
  if (declared !== null && (!Number.isSafeInteger(Number(declared)) || Number(declared) > maxBytes)) {
    response.writeHead(413).end();
    return;
  }
  response.statusCode = source.status;
  const contentType = source.headers.get('content-type');
  if (contentType) response.setHeader('content-type', contentType);
  response.setHeader('cache-control', 'no-store');
  response.setHeader('x-content-type-options', 'nosniff');
  if (!source.body) {
    response.end();
    return;
  }
  const reader = source.body.getReader();
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        response.destroy();
        return;
      }
      response.write(value);
    }
    response.end();
  } finally {
    reader.releaseLock();
  }
}

async function fetchAllowedTarget(request, response, policy, netFetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timeout.unref?.();
  request.once('aborted', () => controller.abort());
  try {
    const upstream = await netFetch(policy.url.href, {
      headers: {
        accept: policy.maxBytes === CATALOG_MAX_BYTES ? 'application/json' : 'application/octet-stream',
      },
      redirect: 'error',
      signal: controller.signal,
    });
    await pipeBoundedResponse(upstream, response, policy.maxBytes);
  } finally {
    clearTimeout(timeout);
  }
}

async function handleBridgeRequest(request, response, token, netFetch) {
  response.setHeader('cache-control', 'no-store');
  if (request.method !== 'POST' || request.url !== '/fetch') {
    response.writeHead(404).end();
    return;
  }
  if (request.headers.authorization !== `Bearer ${token}`) {
    response.writeHead(401).end();
    return;
  }
  try {
    const body = await readRequestJson(request);
    const policy = targetPolicy(typeof body?.url === 'string' ? body.url : '');
    if (!policy) {
      response.writeHead(403).end();
      return;
    }
    await fetchAllowedTarget(request, response, policy, netFetch);
  } catch (error) {
    if (!response.headersSent) response.writeHead(error?.message === 'REQUEST_TOO_LARGE' ? 413 : 502);
    response.end();
  }
}

function createPluginNetworkBridge({ netFetch }) {
  if (typeof netFetch !== 'function') throw new TypeError('Electron net.fetch is required');
  const token = crypto.randomBytes(32).toString('base64url');
  let server;

  return {
    async start() {
      if (server) throw new Error('Plugin network bridge already started');
      server = http.createServer((request, response) => handleBridgeRequest(request, response, token, netFetch));
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, LOOPBACK_HOST, resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Plugin network bridge did not bind TCP');
      return { endpoint: `http://${LOOPBACK_HOST}:${address.port}`, token };
    },
    async close() {
      const active = server;
      server = undefined;
      if (!active) return;
      await new Promise((resolve, reject) => active.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

module.exports = { createPluginNetworkBridge };
