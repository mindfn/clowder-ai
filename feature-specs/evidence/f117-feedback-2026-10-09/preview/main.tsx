import React from 'react';
import { createRoot } from 'react-dom/client';
import { AppendedInputReceipts } from '@/components/AppendedInputReceipts';
import { ChatInput } from '@/components/ChatInput';
import { ReplyPill } from '@/components/ReplyPill';
import { ThreadExecutionBar } from '@/components/ThreadExecutionBar';
import { useActiveExecutionStore } from '@/stores/activeExecutionStore';
import { useChatStore } from '@/stores/chatStore';
import '@/app/theme-tokens.css';
import '@/app/theme-extras.css';
import '@/app/connector-tokens.css';
import '@/app/console-tokens.css';
import '@/app/console-shell.css';
import '@/app/console-controls.css';
import '@/app/shell-v2.css';
import '@/app/cat-persona-tokens.css';
import '@/app/cat-persona-derived.css';
import '@/app/globals.css';

const cat = {
  id: 'opus',
  displayName: '布偶猫',
  variantLabel: 'opus',
  color: { primary: '#A78BFA', secondary: '#EDE9FE' },
  avatar: '',
  mentionPatterns: ['@opus'],
  clientId: 'claude',
  carrier: 'cli',
  defaultModel: 'test',
  roleDescription: 'preview',
  personality: '',
  messageDeliveryCapabilities: { guideReply: true },
};
const threadId = 'feedback-preview';
const now = new Date(2026, 9, 9, 12, 26, 0).getTime();
const execution = (id) => ({
  executionId: id,
  threadId,
  catId: id === 'one' ? 'opus' : 'codex',
  kind: 'live_invocation',
  startedAt: Date.now() - 5000,
  cancelability: {
    state: 'cancelable',
    target: { kind: 'live_invocation', threadId, catId: id === 'one' ? 'opus' : 'codex', executionId: id },
  },
});
window.fixtureExecutions = [execution('one'), execution('two')];
window.fixtureRequests = [];
window.fixtureCats = [
  cat,
  {
    ...cat,
    id: 'codex',
    displayName: '缅因猫',
    variantLabel: 'sol',
    color: { primary: '#6B9B68', secondary: '#DDEADC' },
    mentionPatterns: ['@sol'],
  },
];
useChatStore.setState({
  currentThreadId: threadId,
  threads: [
    {
      id: threadId,
      title: 'preview',
      projectPath: '/fixture',
      createdAt: now,
      lastActiveAt: now,
      participants: [],
      createdBy: 'preview',
    },
  ],
  targetCats: ['opus'],
  hasActiveInvocation: true,
  activeInvocations: { one: { catId: 'opus', mode: 'execute' }, two: { catId: 'codex', mode: 'execute' } },
});
const store = useActiveExecutionStore.getState();
const version = store.beginHydration(threadId, '/fixture');
store.applySnapshot(threadId, version, { projectPath: '/fixture', executions: window.fixtureExecutions });
const response = {
  id: 'response',
  type: 'assistant',
  from: { kind: 'agent', catId: 'opus' },
  catId: 'opus',
  content: '收到',
  timestamp: now,
  lifecycle: {
    kind: 'response',
    orderKey: 'r',
    invocationId: 'invocation',
    targetId: 'opus',
    inputEntryIds: ['initial', 'a', 'b'],
    inputMessageIds: ['initial', 'a', 'b'],
    status: 'processing',
    startedAt: now,
  },
};
const source = (id, read) => ({
  id,
  type: 'user',
  from: { kind: 'user', userId: 'preview' },
  content: read ? '这条有精确读取回执' : '这条只确认已投递。'.repeat(35),
  timestamp: now + 1000,
  lifecycle: {
    kind: 'input',
    orderKey: id,
    entryId: id,
    dispatchRefs: [
      {
        targetId: 'opus',
        statusMessageId: 'response',
        dispatchedAt: now + 2000,
        status: 'dispatched',
        ...(read ? { inputRead: { status: 'read', at: now + 3000 } } : {}),
      },
    ],
  },
});
createRoot(document.getElementById('root')).render(
  <main
    style={{
      maxWidth: 760,
      margin: '32px auto',
      padding: 20,
      '--color-opus-primary': '#A78BFA',
      '--color-codex-primary': '#6B9B68',
    }}
  >
    <h1>F117 当前组件隔离预览</h1>
    <p>使用合成输入与内存 API；不连接运行实例或模型。</p>
    <ReplyPill
      replyToId="initial"
      replyPreview={{ from: { kind: 'agent', catId: 'opus' }, senderCatId: 'opus', content: '原始引用消息' }}
      getCatById={(id) => window.fixtureCats.find((c) => c.id === id)}
    />
    <AppendedInputReceipts
      response={response}
      timelineMessages={[source('a', false), source('b', true)]}
      getCatById={(id) => window.fixtureCats.find((c) => c.id === id)}
    />
    <div style={{ marginTop: 32 }}>
      <ThreadExecutionBar threadId={threadId} />
      <ChatInput threadId={threadId} onSend={async () => true} />
    </div>
  </main>,
);
