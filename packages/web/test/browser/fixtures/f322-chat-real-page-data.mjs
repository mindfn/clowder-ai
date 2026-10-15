import assert from 'node:assert/strict';

// HTTP fixture only: all product reads/writes still go through production apiFetch.
export const CURRENT_THREAD = 'composer-proof-0';
export const BUSY_THREAD = 'composer-proof-1';
export const PROJECT_PATH = '/work/projects/accepted-composer-with-a-very-long-project-name';
export const GROUP_ID = 'composer-proof-group';
export const GROUP_TITLE = '输入框与侧栏的真实使用 · 带长标题的完整协作讨论组';
export const DRAFT = '下周开会的封面就定这张了，再帮我看看右侧的留白。';
export const cats = [
  ['codex-astra', 'Astra', '#4e8278'],
  ['codex61-sol', 'Sol', '#b38341'],
  ['codex6-luna', 'Luna', '#97758b'],
].map(([id, displayName, primary]) => ({
  id,
  displayName,
  breedId: 'maine-coon',
  breedDisplayName: '缅因猫',
  clientId: 'openai',
  avatar: `/avatars/family/${id}.png`,
  color: { primary, secondary: '#eeeeee' },
  mentionPatterns: [`@${id}`],
  defaultModel: 'fixture',
  roster: { family: 'maine-coon', available: true, roles: [], lead: false, evaluation: '' },
}));

const readingBody = Array.from(
  { length: 7 },
  (_, i) =>
    `第${i + 1}段：${'先从实际页面核对，让长篇回复有合适的行长，也让名牌、状态和作品留在同一阅读栏里。'.repeat(3)}`,
).join('\n\n');

export function createChatProofApi(now = Date.now(), crowded = false, surface = false) {
  const roster = crowded
    ? [
        ...cats,
        ...Array.from({ length: 9 }, (_, index) => ({
          ...cats[0],
          id: `fixture-partner-${index + 4}`,
          displayName: `Partner ${index + 4}`,
          mentionPatterns: [],
        })),
      ]
    : cats;
  const threads = Array.from({ length: 11 }, (_, index) => ({
    id: `composer-proof-${index}`,
    title:
      index === 0
        ? '身体交付｜动作语义、素材与砚砚的下一轮真实使用'
        : index === 1
          ? '正在执行的完整长标题：检查素材、确认结构并保留每一个未完成的操作'
          : `协作讨论 ${index + 1}`,
    projectPath: PROJECT_PATH,
    participants: cats.map((cat) => cat.id),
    preferredCats: [],
    createdBy: 'owner-proof',
    createdAt: now - 86_400_000,
    lastActiveAt: now - index * 60_000,
    pinned: true,
    favorited: false,
    labels: [],
    systemKind: null,
    isHubThread: false,
    unreadCount: index === 1 ? (crowded ? 120 : 6) : 0,
    hasUserMention: index === 1,
    presence:
      index === 1
        ? {
            status: 'working',
            cats: crowded ? roster.map((cat) => cat.id) : ['codex-astra', 'codex61-sol'],
            activeSince: now - 7 * 60_000,
          }
        : index === 2
          ? { status: 'done', cats: ['codex6-luna'] }
          : { status: 'idle' },
  }));
  const preferences = {
    aliases: {},
    open: { [`group:${GROUP_ID}`]: true },
    memberSort: {},
    collapsedPeek: {},
    groups: [{ id: GROUP_ID, name: GROUP_TITLE, threadIds: threads.map((thread) => thread.id) }],
  };
  let draft = {
    version: 1,
    ownerUserId: 'owner-proof',
    threadId: CURRENT_THREAD,
    revision: 1,
    text: DRAFT,
    updatedAt: now,
  };
  let revision = 1;
  const requests = [];
  const sent = [];
  const decisions = [];
  const reply = (body, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
  function respond(request, url) {
    const method = request.method();
    const body = method === 'GET' ? null : request.postDataJSON();
    requests.push({ method, path: url.pathname, search: url.search, body });
    if (url.pathname === '/api/session') return reply({ userId: 'owner-proof', csrfToken: 'fixture-only' });
    if (url.pathname === '/api/concierge/work/decisions' && method === 'GET') {
      assert.equal(url.searchParams.get('view'), 'unified');
      const offset = Number(url.searchParams.get('offset'));
      const limit = Number(url.searchParams.get('limit'));
      assert.equal(limit, 20);
      assert.ok(Number.isInteger(offset) && offset >= 0);
      const source = { status: 'available', exhaustiveness: 'complete' };
      return reply({
        version: 1,
        status: 'available',
        scope: 'owner_all_projects',
        identity: { ownerUserId: 'owner-proof' },
        observedAt: now,
        sources: { approvals: source, needsMe: source, structuredChoices: source },
        readWindow: { startedAt: now, endedAt: now, consistency: 'independent_source_reads' },
        consistency: { state: 'verified', reasons: [] },
        items: decisions.slice(offset, offset + limit),
        totalCount: decisions.length,
        page: { offset, limit, scope: 'known_rows', hasMore: offset + limit < decisions.length },
      });
    }
    if (url.pathname === '/api/cats') return reply({ cats: roster });
    if (url.pathname === '/api/config/cat-order') return reply({ catOrder: roster.map((cat) => cat.id) });
    if (url.pathname === '/api/routing/preview' && method === 'POST') {
      // Recipient preview is a read, despite its POST transport. Only this exact
      // contract is admitted; other unknown mutations still fail closeProof.
      assert.equal(body.scope, 'thread');
      assert.deepEqual(Object.keys(body).sort(), ['content', 'scope', 'threadId']);
      assert.equal(typeof body.content, 'string');
      assert.ok(body.content.length <= 50_000);
      const thread = threads.find((entry) => entry.id === body.threadId);
      if (!thread) return reply({ error: 'Thread not found' }, 404);
      return reply({ targetCats: [cats[0].id], reason: { kind: 'recent_replier' } });
    }
    if (url.pathname === '/api/backlog/items' && method === 'GET') return reply({ items: [] });
    if (url.pathname === '/api/threads' && method === 'GET') return reply({ threads });
    if (url.pathname === '/api/config/thread-attention') {
      if (method === 'PUT') {
        assert.ok(Object.keys(body).every((key) => ['anchor', 'open', 'collapsedPeek'].includes(key)));
        assert.equal(typeof body.anchor, 'string');
        if (body.open !== undefined) {
          assert.equal(typeof body.open, 'boolean');
          preferences.open[body.anchor] = body.open;
        }
        if (body.collapsedPeek !== undefined) {
          assert.equal(typeof body.collapsedPeek, 'boolean');
          preferences.collapsedPeek[body.anchor] = body.collapsedPeek;
        }
      }
      return reply(preferences);
    }
    if (url.pathname === '/api/config/conversation-view')
      return reply({ stored: null, effective: { mode: 'group' }, source: 'product' });
    if (url.pathname === `/api/threads/${CURRENT_THREAD}/composer-draft`) {
      if (method !== 'GET') {
        if (body.expectedRevision !== revision) return reply({ error: 'conflict' }, 409);
        revision++;
        draft = method === 'DELETE' ? null : { ...draft, ...body, revision, threadId: CURRENT_THREAD, updatedAt: now };
      }
      return reply({ draft, revision });
    }
    if (surface && url.pathname === '/api/messages' && method === 'GET')
      return reply({
        messages: [
          {
            id: 'reading-human',
            catId: null,
            content: '请把这段真实使用中的长对话放回阅读栏，保留原有内容和操作。'.repeat(20),
            timestamp: now - 2000,
          },
          {
            id: 'reading-cat',
            catId: 'codex-astra',
            origin: 'stream',
            content: readingBody,
            contentBlocks: [
              { type: 'text', text: readingBody },
              { type: 'image', url: '/avatars/family/codex-astra.png' },
            ],
            toolEvents: [
              {
                id: 'command',
                type: 'tool_use',
                label: 'Bash',
                detail: JSON.stringify({ command: 'python3 -c "' + 'long argument '.repeat(25) + '"' }),
                timestamp: now,
              },
            ],
            extra: {
              stream: { invocationId: 'reading-inv', turnInvocationId: 'reading-turn' },
              rich: {
                v: 1,
                blocks: [
                  {
                    v: 1,
                    id: 'reading-artwork',
                    kind: 'card',
                    title: '阅读栏中的作品',
                    bodyMarkdown: '作品和操作回执跟着正文，使用同一阅读栏。',
                  },
                ],
              },
            },
            timestamp: now - 1000,
          },
        ],
        hasMore: false,
      });
    if (surface && url.pathname.endsWith('/vote')) return reply({ vote: null });
    if (surface && url.pathname.endsWith('/memory-cues')) return reply({ cues: [] });
    if (surface && url.pathname === '/api/tasks') return reply({ tasks: [] });
    if (surface && url.pathname.endsWith('/task-progress')) return reply({ tasks: [] });
    if (surface && url.pathname.endsWith('/queue')) return reply({ queue: [], activeInvocations: [] });
    if (surface && url.pathname === '/api/recall/events') return reply({ events: [], hasMore: false });
    if (surface && ['/api/health', '/api/ready'].includes(url.pathname)) return reply({ status: 'ok', ready: true });
    if (url.pathname === '/api/messages' && method === 'POST') {
      sent.push(body);
      return reply({ ok: true, id: `accepted-${sent.length}` });
    }
    const thread = threads.find((entry) => url.pathname === `/api/threads/${entry.id}`);
    if (thread) {
      if (method === 'PATCH') {
        if (Object.keys(body).some((key) => key !== 'preferredCats'))
          return reply({ error: 'unexpected mutation' }, 400);
        thread.preferredCats = body.preferredCats;
      }
      return reply(thread);
    }
    if (/^\/api\/threads\/composer-proof-\d+\/active-pane$/.test(url.pathname)) return reply({ active: false });
    if (url.pathname.endsWith('/session-strategy')) return reply({ strategy: 'resume', source: 'default' });
    const bodies = {
      '/api/labels': [],
      '/api/governance/health': { projects: [] },
      '/api/config': { ui: { bubbleDefaults: { thinking: 'collapsed', cliOutput: 'collapsed' } } },
      '/api/config/env': {},
      '/api/config/env-summary': { variables: [] },
    };
    return Object.hasOwn(bodies, url.pathname) ? reply(bodies[url.pathname]) : null;
  }
  return { respond, requests, threads, preferences, sent, decisions };
}
