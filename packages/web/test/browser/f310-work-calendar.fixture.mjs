import { once } from 'node:events';
import { createServer } from 'node:http';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import '../../../api/test/helpers/setup-cat-registry.js';
import { InvocationRegistry } from '../../../api/dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { TaskStore } from '../../../api/dist/domains/cats/services/stores/ports/TaskStore.js';
import { EntrustedWorkLifecycleService } from '../../../api/dist/domains/growing/EntrustedWorkLifecycleService.js';
import { EntrustedWorkOwnerReadService } from '../../../api/dist/domains/growing/EntrustedWorkOwnerReadService.js';
import { F232PreparedArtifactReader } from '../../../api/dist/domains/growing/F232PreparedArtifactReader.js';
import { sessionAuthPlugin, sessionRoute } from '../../../api/dist/infrastructure/session-auth.js';
import { registerEntrustedWorkReadRoutes } from '../../../api/dist/routes/entrusted-work-read-routes.js';
import { fixedFixture, realSurfaceApiResponse } from './f307-real-surface-fixtures.mjs';
import { readJ3Attention } from './f322-j3-attention.fixture.mjs';

export const CALENDAR_THREAD = 'thread-f310-calendar-contract';

export async function createCalendarFixture() {
  const now = Date.now();
  const title = `开发工作日历 ${now}`;
  const sentinel = `可读成果 ${now}`;
  let publicationAt = now - 1000;
  const artifactUrl = '/uploads/calendar-contract.md';
  const publication = () => ({
    type: 'file',
    name: '工作日历交付.md',
    url: artifactUrl,
    catId: 'codex',
    sourceMessageId: `publication-${publicationAt}`,
    createdAt: publicationAt,
    threadId: CALENDAR_THREAD,
    threadTitle: '工作日历',
  });
  const messages = {
    async getByThread() {
      const p = publication();
      return [
        ...Array.from({ length: 36 }, (_, index) => ({
          id: `j3-controlled-reading-${index}`,
          threadId: CALENDAR_THREAD,
          userId: 'default-user',
          catId: 'codex',
          timestamp: now - 3600000 + index * 1000,
          content: `受控阅读样本 ${index + 1}，用于原聊天位置验证。\n\n${'这是可滚动的原聊天样本正文，不代表真实猫执行。保留可见消息位置，再去日程查看成果。\n\n'.repeat(3)}`,
        })),
        {
          id: p.sourceMessageId,
          threadId: CALENDAR_THREAD,
          userId: 'default-user',
          catId: 'codex',
          timestamp: publicationAt,
          content: '交付材料',
          extra: {
            rich: { blocks: [{ kind: 'file', v: 1, id: p.sourceMessageId, fileName: p.name, url: artifactUrl }] },
          },
        },
      ];
    },
    async getByThreadBefore() {
      return [];
    },
  };
  const artifactReader = new F232PreparedArtifactReader({ messages });
  const tasks = new TaskStore();
  const lifecycle = new EntrustedWorkLifecycleService(tasks, { artifactReader });
  const reader = new EntrustedWorkOwnerReadService({
    tasks,
    artifactReader,
    producerCatalog: {
      async listCurrentReceipts() {
        return [];
      },
    },
  });
  async function admit(name, key) {
    const result = await lifecycle.admitOrResume({
      task: {
        threadId: CALENDAR_THREAD,
        title: name,
        why: 'Original source stays in details',
        ownerCatId: 'codex',
        createdBy: 'codex',
        userId: 'default-user',
      },
      admission: {
        basis: 'explicit_entrustment',
        sourceRefs: [`message:${key}`],
        intendedOutcome: name,
        idempotencyKey: key,
      },
      closure: { condition: 'Usable work delivered', expectedSignal: 'message:acceptance' },
    });
    return result.ownerRef.slice('task:item:'.length);
  }
  const taskId = await admit(title, 'calendar');
  await lifecycle.update({
    taskId,
    expectedRevision: 1,
    status: 'doing',
    artifactRefs: [artifactUrl],
    time: {
      actualStart: { value: now - 3600000, sourceRef: 'message:start' },
      estimatedCompletion: { value: now + 86400000, sourceRef: 'message:estimate' },
    },
    progress: { summary: '日期和正在做的工作已同屏', nextStep: '检查完成后的成果回看', sourceRef: 'message:progress' },
  });
  const blockedId = await admit('核对待确认的材料', 'blocked');
  await lifecycle.update({
    taskId: blockedId,
    expectedRevision: 1,
    status: 'blocked',
    time: { businessDeadline: { value: now - 86400000, sourceRef: 'message:deadline' } },
    progress: { summary: '材料核对尚未结束', blockerReason: '等待已登记的审阅结果', sourceRef: 'message:blocker' },
  });
  const undatedId = await admit('没有截止的开发责任', 'undated');
  const undatedBlockedId = await admit('未排期受阻的原责任', 'undated-blocked');
  await lifecycle.update({
    taskId: undatedBlockedId,
    expectedRevision: 1,
    status: 'blocked',
    artifactRefs: [artifactUrl],
    progress: {
      summary: '受控样本：原材料待确认',
      blockerReason: '等待原审阅结果',
      sourceRef: 'message:undated-blocker',
    },
  });
  const undatedSampleIds = [];
  for (let index = 0; index < 20; index++) {
    const sampleId = await admit(`受控未排期工作 ${index + 1}`, `undated-sample-${index}`);
    undatedSampleIds.push(sampleId);
    if (index === 9) {
      await lifecycle.update({ taskId: sampleId, expectedRevision: 1, status: 'todo', artifactRefs: [artifactUrl] });
    }
  }
  const native = Fastify();
  await native.register(cookie);
  await native.register(sessionAuthPlugin);
  await native.register(sessionRoute);
  registerEntrustedWorkReadRoutes(native, { service: reader, callbackRegistry: new InvocationRegistry() });
  let readsUnavailable = false;
  let catalogForbidden = false;
  const thread = { id: CALENDAR_THREAD, userId: 'default-user', title: '工作日历', createdAt: now, updatedAt: now };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture.local');
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-cat-cafe-user');
    if (req.method === 'OPTIONS') {
      res.end();
      return;
    }
    try {
      if (url.pathname.startsWith('/api/entrusted-work/') || url.pathname === '/api/session') {
        if (readsUnavailable && url.pathname !== '/api/session') {
          res.writeHead(503);
          res.end('{}');
          return;
        }
        const result = await native.inject({
          method: 'GET',
          url: req.url,
          headers: req.headers,
          remoteAddress: req.socket.remoteAddress,
        });
        res.writeHead(result.statusCode, result.headers);
        res.end(result.body);
        return;
      }
      if (catalogForbidden && url.pathname === `/api/threads/${CALENDAR_THREAD}/artifacts`) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Controlled original publication read denied' }));
        return;
      }
      if (url.pathname === '/api/concierge/work/decisions') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(await readJ3Attention(url, now)));
        return;
      }
      if (url.pathname === artifactUrl) {
        res.setHeader('Content-Type', 'text/markdown');
        res.end(`# 工作日历\n\n${sentinel}\n`);
        return;
      }
      const overrides = new Map([
        ['/api/messages', { messages: await messages.getByThread(), hasMore: false }],
        ['/api/threads', { threads: [thread] }],
        [`/api/threads/${CALENDAR_THREAD}`, thread],
        [`/api/threads/${CALENDAR_THREAD}/sessions`, { sessions: [] }],
        [`/api/threads/${CALENDAR_THREAD}/artifacts`, { threadId: CALENDAR_THREAD, artifacts: [publication()] }],
        ['/api/artifacts', { artifacts: [publication()], total: 1, workLineage: 'unavailable' }],
        ['/api/cats', fixedFixture('/api/cats')],
        ['/api/capability-evolution/programs', { programs: [] }],
        ['/api/tasks', { tasks: [] }],
      ]);
      const result = overrides.has(url.pathname)
        ? { body: overrides.get(url.pathname) }
        : await realSurfaceApiResponse({ url: () => url.href, method: () => req.method }, false);
      res.writeHead(result?.status ?? 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result?.body ?? {}));
    } catch (error) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: error.message }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    threadId: CALENDAR_THREAD,
    title,
    sentinel,
    artifactUrl,
    taskId,
    undatedId,
    undatedBlockedId,
    undatedSampleIds,
    blockedId,
    now,
    apiPort: server.address().port,
    async complete() {
      return lifecycle.close({
        taskId,
        expectedRevision: 2,
        closure: {
          state: 'satisfied',
          condition: 'Usable work delivered',
          expectedSignal: 'message:acceptance',
          evidenceRefs: ['message:acceptance'],
        },
      });
    },
    republish() {
      publicationAt += 1000;
    },
    unavailable(value) {
      readsUnavailable = value;
    },
    forbidCatalog(value) {
      catalogForbidden = value;
    },
    async close() {
      server.close();
      server.closeAllConnections();
      await native.close();
    },
  };
}
