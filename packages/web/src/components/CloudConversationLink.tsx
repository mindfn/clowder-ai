'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { parseChatGptConversationUrl } from '@/utils/chatgpt-chat-url';
import { personalChromeSettingsHref } from '@/utils/personal-chrome-settings';
import { cloudConversationCopy } from './cloud-conversation.shell-copy';
import { useTrajectoryCopy } from './workspace/trajectory/use-trajectory-copy';

interface CloudBindingsResponse {
  bindings?: Record<string, string>;
}

type BindingState =
  | { kind: 'loading' }
  | { kind: 'empty' }
  | { kind: 'bound'; chatUrl: string; conversationId: string }
  | { kind: 'unauthorized' }
  | { kind: 'invalid' }
  | { kind: 'error' };

interface ThreadBindingState {
  threadId: string;
  value: BindingState;
}

const LOADING_BINDING: BindingState = { kind: 'loading' };

async function readCloudConversationBinding(threadId: string, signal: AbortSignal): Promise<BindingState | null> {
  const response = await apiFetch(`/api/threads/${encodeURIComponent(threadId)}/cloud-bindings`, { signal });
  if (signal.aborted) return null;
  if (response.status === 401 || response.status === 403) return { kind: 'unauthorized' };
  if (!response.ok) throw new Error(`Cloud conversation binding read failed (${response.status})`);

  const body = (await response.json()) as CloudBindingsResponse;
  if (signal.aborted) return null;
  const rawBinding = body.bindings?.['gpt-pro'];
  if (rawBinding === undefined) return { kind: 'empty' };

  const parsed = parseChatGptConversationUrl(rawBinding);
  return parsed ? { kind: 'bound', ...parsed } : { kind: 'invalid' };
}

function bindingStatus(binding: BindingState, t = cloudConversationCopy.zh) {
  if (binding.kind === 'loading') return t.loading;
  if (binding.kind === 'empty') return t.empty;
  if (binding.kind === 'unauthorized') return t.unauthorized;
  if (binding.kind === 'invalid') return t.invalid;
  if (binding.kind === 'error') return t.error;
  return null;
}

export function CloudConversationLink({ threadId, compact = false }: { threadId: string; compact?: boolean }) {
  const t = useTrajectoryCopy(cloudConversationCopy);
  const [threadBinding, setThreadBinding] = useState<ThreadBindingState>(() => ({
    threadId,
    value: LOADING_BINDING,
  }));
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyOperationRef = useRef(0);
  const currentThreadIdRef = useRef(threadId);
  const currentChatUrlRef = useRef<string | null>(null);
  const binding = threadBinding.threadId === threadId ? threadBinding.value : LOADING_BINDING;

  currentThreadIdRef.current = threadId;
  currentChatUrlRef.current = binding.kind === 'bound' ? binding.chatUrl : null;

  useEffect(() => {
    const controller = new AbortController();
    copyOperationRef.current += 1;
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = null;
    setThreadBinding({ threadId, value: LOADING_BINDING });
    setCopyState('idle');

    void readCloudConversationBinding(threadId, controller.signal)
      .then((nextBinding) => {
        if (nextBinding && !controller.signal.aborted) setThreadBinding({ threadId, value: nextBinding });
      })
      .catch(() => {
        if (!controller.signal.aborted) setThreadBinding({ threadId, value: { kind: 'error' } });
      });

    return () => {
      controller.abort();
      copyOperationRef.current += 1;
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = null;
    };
  }, [threadId]);

  const copyLink = useCallback(async () => {
    if (binding.kind !== 'bound') return;
    const operation = copyOperationRef.current + 1;
    copyOperationRef.current = operation;
    const operationThreadId = threadId;
    const operationChatUrl = binding.chatUrl;
    const isCurrentOperation = () =>
      copyOperationRef.current === operation &&
      currentThreadIdRef.current === operationThreadId &&
      currentChatUrlRef.current === operationChatUrl;

    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = null;

    let nextCopyState: 'copied' | 'failed';
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(operationChatUrl);
      nextCopyState = 'copied';
    } catch {
      nextCopyState = 'failed';
    }

    if (!isCurrentOperation()) return;
    setCopyState(nextCopyState);
    copyTimerRef.current = setTimeout(() => {
      if (!isCurrentOperation()) return;
      copyTimerRef.current = null;
      setCopyState('idle');
    }, 1500);
  }, [binding, threadId]);

  const status = bindingStatus(binding, t);
  const settingsHref = personalChromeSettingsHref(threadId);

  if (compact) {
    return (
      <div className="status-v2-info-row" data-testid="cloud-conversation-link">
        <span className="status-v2-muted">ChatGPT</span>
        {binding.kind === 'bound' ? (
          <code className="status-v2-cloud-id" title={binding.chatUrl}>
            {binding.conversationId}
          </code>
        ) : (
          <span className="status-v2-cloud-id">{status}</span>
        )}
        <span className="status-v2-info-actions">
          {(binding.kind === 'bound' || binding.kind === 'empty') && (
            <a
              href={binding.kind === 'bound' ? binding.chatUrl : 'https://chatgpt.com/'}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t.openChatGPT}
            </a>
          )}
          {binding.kind === 'bound' && (
            <button type="button" aria-label={t.copyLabel} onClick={() => void copyLink()} aria-live="polite">
              {copyState === 'copied' ? t.copied : copyState === 'failed' ? t.copyFailed : t.copyLink}
            </button>
          )}
          {binding.kind !== 'loading' && binding.kind !== 'unauthorized' && (
            <a href={settingsHref} title={t.instructions}>
              {binding.kind === 'bound' ? t.change : binding.kind === 'empty' ? t.select : t.check}
            </a>
          )}
        </span>
      </div>
    );
  }

  return (
    <div className="console-list-card mt-2 min-w-0 rounded-xl p-2.5" data-testid="cloud-conversation-link">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="text-xs font-semibold text-cafe">{t.title}</span>
        <span className="shrink-0 rounded-full bg-[var(--console-hover-bg)] px-1.5 py-0.5 text-micro font-medium text-cafe-secondary">
          {t.cloudCat}
        </span>
      </div>
      <div className="mt-1 min-w-0 text-micro text-cafe-secondary">
        {binding.kind === 'bound' ? (
          <code className="block truncate font-mono" title={binding.chatUrl}>
            {binding.conversationId}
          </code>
        ) : (
          <span className="text-cafe-muted">{status}</span>
        )}
      </div>
      {binding.kind === 'bound' ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-micro" aria-live="polite">
          <button
            type="button"
            className="font-medium text-cafe-secondary transition-colors hover:text-cafe"
            aria-label={t.copyLabel}
            onClick={() => void copyLink()}
          >
            {copyState === 'copied' ? t.copied : copyState === 'failed' ? t.copyFailed : t.copyLink}
          </button>
          <a
            className="font-medium text-cafe-secondary transition-colors hover:text-cafe"
            href={binding.chatUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={t.openLabel}
          >
            {t.open}
          </a>
          <a className="font-medium text-cafe-muted transition-colors hover:text-cafe" href={settingsHref}>
            {t.change}
          </a>
        </div>
      ) : binding.kind === 'empty' ? (
        <div className="mt-1.5 text-micro text-cafe-muted">
          <p>{t.instructions}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <a
              className="font-medium text-cafe-secondary transition-colors hover:text-cafe"
              href="https://chatgpt.com/"
              target="_blank"
              rel="noopener noreferrer"
            >
              {t.openChatGPT}
            </a>
            <a className="font-medium text-cafe-secondary transition-colors hover:text-cafe" href={settingsHref}>
              {t.settings}
            </a>
          </div>
        </div>
      ) : binding.kind === 'invalid' || binding.kind === 'error' ? (
        <a
          className="mt-1.5 inline-block text-micro font-medium text-cafe-secondary transition-colors hover:text-cafe"
          href={settingsHref}
        >
          {t.check}
        </a>
      ) : null}
    </div>
  );
}
