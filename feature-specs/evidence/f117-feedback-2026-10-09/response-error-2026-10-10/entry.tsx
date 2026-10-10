import React from 'react';
import { createRoot } from 'react-dom/client';
import { ChatMessage } from '/Users/lang/workspace/github-lab/cat-cafe-append-receipt-feedback/packages/web/src/components/ChatMessage';
import { primeCoCreatorConfigCache } from '/Users/lang/workspace/github-lab/cat-cafe-append-receipt-feedback/packages/web/src/hooks/useCoCreatorConfig';
import { useChatStore } from '/Users/lang/workspace/github-lab/cat-cafe-append-receipt-feedback/packages/web/src/stores/chatStore';

window.fetch = async () => new Response('{}', { status: 200 });
primeCoCreatorConfigCache({ name: 'lang', aliases: [], mentionPatterns: [] });
const error = "You've hit your session limit · resets 11:50pm (America/Los_Angeles)";
const message = {
  id: 'response',
  from: { kind: 'agent', catId: 'opus' },
  type: 'assistant',
  catId: 'opus',
  content: error,
  timestamp: 1791604122472,
  lifecycle: {
    kind: 'response',
    orderKey: '1:response',
    invocationId: 'turn',
    targetId: 'opus',
    inputEntryIds: ['entry'],
    inputMessageIds: ['source'],
    status: 'failed',
    startedAt: 1791604122400,
    completedAt: 1791604122472,
  },
  extra: {
    cliDiagnostics: {
      publicSummary: 'Claude Code 报告：' + error,
      publicHint: '展开看完整原因；可换一只猫或刷新对话重试。',
      safeExcerpt: error,
      excerptSource: 'cc_structured',
      debugRef: { command: 'claude-agent-sdk', exitCode: 1, signal: null },
    },
  },
};
const cat = {
  id: 'opus',
  displayName: '布偶猫',
  variantLabel: 'opus',
  mentionPatterns: [],
  clientId: 'claude',
  defaultModel: 'claude-opus-5-5',
  avatar: '',
  color: { primary: '#9d86bb', secondary: '#e6ddee' },
  roleDescription: '',
  personality: '',
};
useChatStore.setState({ currentThreadId: 'preview', messages: [message], threads: [], isLoadingThreads: false });
createRoot(document.getElementById('root')!).render(
  <ChatMessage message={message} threadId="preview" getCatById={() => cat} />,
);
setTimeout(() => {
  document.getElementById('receipt')!.textContent = JSON.stringify({
    errorCount: document.getElementById('root')!.textContent!.split(error).length - 1,
    panels: document.querySelectorAll('[data-testid="cli-diagnostics"], [data-testid="timeout-diagnostics"]').length,
    extraPreserved: message.extra.cliDiagnostics.safeExcerpt === error,
  });
}, 1000);
