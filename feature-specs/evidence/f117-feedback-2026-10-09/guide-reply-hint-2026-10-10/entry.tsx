import React from 'react';
import { createRoot } from 'react-dom/client';
import { ChatInput } from '/Users/lang/workspace/github-lab/cat-cafe-append-receipt-feedback/packages/web/src/components/ChatInput';
import { useChatStore } from '/Users/lang/workspace/github-lab/cat-cafe-append-receipt-feedback/packages/web/src/stores/chatStore';

const variant = new URLSearchParams(location.search).get('case') || 'mixed';
const ids = variant === 'none' ? ['b'] : variant === 'idle' ? [] : ['a', 'b', 'c'];
window.fetch = async () =>
  new Response(
    JSON.stringify({
      productDefault: 'next_work',
      global: null,
      thread: variant === 'next' ? 'next_work' : 'continue_current',
      effective: variant === 'next' ? 'next_work' : 'continue_current',
      source: 'thread',
    }),
    { status: 200 },
  );
useChatStore.setState({
  currentThreadId: 'preview',
  targetCats: ids,
  hasActiveInvocation: ids.length > 0,
  activeInvocations: Object.fromEntries(ids.map((id) => ['inv-' + id, { catId: id, mode: 'execute' }])),
  catInvocations: {},
});
createRoot(document.getElementById('root')!).render(<ChatInput threadId="preview" onSend={() => true} />);
setTimeout(() => {
  const ta = document.querySelector('textarea')!;
  document.getElementById('receipt')!.textContent = JSON.stringify({
    variant,
    placeholder: ta.placeholder,
    banner: !!document.querySelector('[data-testid="active-invocation-banner"]'),
    stop: !!document.querySelector('[aria-label="Stop generation"]'),
  });
}, 1000);
