import type { MessageSearchResponse, MessageSearchResult } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatReadingPort, RegisterChatReadingPort } from '../thread-chat/useThreadChatReadingPort';
import {
  type MessageReadingSession,
  readActiveMessageReadingSession,
  saveMessageReadingSession,
  startMessageReadingSession,
} from './message-reading-session';
import {
  beginMessageReadingTrip,
  interruptMessageReadingTrip,
  type MessageReadingEffect,
  requestMessageReadingReturn,
  requestMessageReadingTarget,
  settleMessageReadingTrip,
} from './message-reading-trip';
import { verifyMessageNavigationSource } from './verify-message-navigation-source';

export interface MessageSearchHost {
  open: boolean;
  session: MessageReadingSession | null;
  persisted: boolean;
  notice: string | null;
  openSearch: () => void;
  closeSearch: () => void;
  registerReadingPort: RegisterChatReadingPort;
  navigateResult: (result: MessageSearchResult, response: MessageSearchResponse) => void;
  moveTo: (index: number) => void;
  returnToOrigin: () => void;
}

interface PendingReadingOperation {
  sessionId: string;
  effect: MessageReadingEffect;
  running: boolean;
  admitted: boolean;
  controller: AbortController;
}

function targetThread(effect: MessageReadingEffect): string {
  return effect.kind === 'target' ? effect.target.threadId : effect.origin.threadId;
}

async function readThroughOwner(port: ChatReadingPort, effect: MessageReadingEffect, signal: AbortSignal) {
  if (effect.kind === 'target') {
    const receipt = await port.navigateToMessage(effect.target.messageId, signal, { refresh: true });
    if (receipt.status !== 'settled') return receipt.status;
    return receipt.threadId === effect.target.threadId && receipt.messageId === effect.target.messageId
      ? ('settled' as const)
      : ('unavailable' as const);
  }
  const receipt = await port.restoreReadingRef(effect.origin.readingRef, signal, { refresh: true });
  if (receipt.status !== 'settled') return receipt.status;
  return receipt.exact ? ('settled' as const) : ('unavailable' as const);
}

function startFromForeground(response: MessageSearchResponse, port: ChatReadingPort | null, threadId: string) {
  if (!port || port.threadId !== threadId) return null;
  const origin = port.captureReadingRef();
  if (!origin) return null;
  const trip = beginMessageReadingTrip(response, { threadId, readingRef: origin.ref });
  return trip ? startMessageReadingSession(trip, origin.persisted) : null;
}

/** A navigation consumer: route and reading owners retain all authorization, paging and geometry. */
export function useMessageSearchHost({
  threadId,
  pushThreadRoute,
  available = true,
}: {
  threadId: string;
  pushThreadRoute: (threadId: string) => void;
  available?: boolean;
}): MessageSearchHost {
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState<MessageReadingSession | null>(null);
  const [persisted, setPersisted] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const current = useRef<MessageReadingSession | null>(null);
  const foregroundThread = useRef(threadId);
  foregroundThread.current = threadId;
  const reader = useRef<ChatReadingPort | null>(null);
  const pending = useRef<PendingReadingOperation | null>(null);
  const entryFocus = useRef<HTMLElement | null>(null);
  const activeDurable = useRef(true);
  const availableNow = useRef(available);
  availableNow.current = available;

  const publish = useCallback((next: MessageReadingSession) => {
    current.current = next;
    setSession(next);
    setPersisted(saveMessageReadingSession(next) && activeDurable.current && next.originPersisted);
  }, []);

  const drive = useCallback(
    async (operation: PendingReadingOperation, port: ChatReadingPort) => {
      if (
        pending.current !== operation ||
        !operation.admitted ||
        operation.running ||
        port.threadId !== targetThread(operation.effect)
      )
        return;
      operation.running = true;
      let status: 'settled' | 'unavailable' | 'interrupted';
      try {
        status = await readThroughOwner(port, operation.effect, operation.controller.signal);
      } catch {
        status = 'unavailable';
      }
      if (pending.current !== operation || current.current?.id !== operation.sessionId) return;
      if (reader.current?.ownerId !== port.ownerId || reader.current?.threadId !== port.threadId)
        status = 'interrupted';
      pending.current = null;
      const next = {
        ...current.current,
        trip: settleMessageReadingTrip(current.current.trip, operation.effect, status),
      };
      publish(next);
      if (status === 'settled' && operation.effect.kind === 'return')
        port.releaseReadingRef(operation.effect.origin.readingRef);
    },
    [publish],
  );

  const registerReadingPort = useCallback<RegisterChatReadingPort>(
    (port) => {
      if (!availableNow.current) return () => {};
      if (port.threadId !== foregroundThread.current) return () => {};
      reader.current = port;
      if (pending.current) void drive(pending.current, port);
      return () => {
        if (reader.current === port) reader.current = null;
      };
    },
    [available, drive],
  );

  const admitAndDrive = useCallback(
    async (operation: PendingReadingOperation) => {
      const { effect } = operation;
      const admission = await verifyMessageNavigationSource(
        effect.kind === 'target' ? effect.target : { threadId: effect.origin.threadId },
        operation.controller.signal,
      );
      if (pending.current !== operation || current.current?.id !== operation.sessionId) return;
      if (admission.status !== 'available') {
        pending.current = null;
        publish({ ...current.current, trip: settleMessageReadingTrip(current.current.trip, effect, 'unavailable') });
        setNotice(
          admission.status === 'forbidden'
            ? '这条来源目前不可访问，已保留返回位置。'
            : '这条来源暂不可定位，已保留返回位置。',
        );
        return;
      }
      operation.admitted = true;
      if (admission.updated) setNotice('来源已更新，将定位到这条消息的当前版本。');
      const port = reader.current;
      if (port?.threadId === targetThread(effect)) void drive(operation, port);
      else pushThreadRoute(targetThread(effect));
    },
    [drive, publish, pushThreadRoute],
  );

  const request = useCallback(
    (next: MessageReadingSession, effect: MessageReadingEffect) => {
      pending.current?.controller.abort();
      publish(next);
      setNotice(null);
      const operation: PendingReadingOperation = {
        sessionId: next.id,
        effect,
        running: false,
        admitted: false,
        controller: new AbortController(),
      };
      pending.current = operation;
      void admitAndDrive(operation);
    },
    [admitAndDrive, publish],
  );

  const moveTo = useCallback(
    (index: number) => {
      if (!availableNow.current) return;
      const active = current.current;
      if (!active) return;
      const requested = requestMessageReadingTarget(active.trip, index);
      if (requested) request({ ...active, trip: requested.trip }, requested.effect);
    },
    [available, request],
  );

  const returnToOrigin = useCallback(() => {
    if (!availableNow.current) return;
    const active = current.current;
    if (!active) return;
    const requested = requestMessageReadingReturn(active.trip);
    if (requested) request({ ...active, trip: requested.trip }, requested.effect);
  }, [available, request]);

  const navigateResult = useCallback(
    (result: MessageSearchResult, response: MessageSearchResponse) => {
      if (!availableNow.current) return;
      const index = response.results.findIndex(
        (candidate) => candidate.threadId === result.threadId && candidate.messageId === result.messageId,
      );
      if (index < 0) {
        setNotice('这条来源不属于当前检索结果，暂不可跳转。');
        return;
      }
      let active = current.current;
      if (!active || active.trip.searchId !== response.searchId || active.trip.status === 'completed') {
        const started = startFromForeground(response, reader.current, foregroundThread.current);
        if (!started) {
          setNotice('当前阅读位置暂不可保存，请在对话中重新尝试。');
          return;
        }
        active = started.session;
        activeDurable.current = started.persisted;
        setPersisted(started.persisted && started.session.originPersisted);
      }
      const indexInCollection = active.trip.targets.findIndex(
        (target) => target.threadId === result.threadId && target.messageId === result.messageId,
      );
      const requested = requestMessageReadingTarget(active.trip, indexInCollection);
      if (!requested) return;
      setOpen(false);
      request({ ...active, trip: requested.trip }, requested.effect);
    },
    [available, request],
  );

  useEffect(() => {
    const recovered = readActiveMessageReadingSession();
    if (recovered) {
      current.current = recovered;
      setSession(recovered);
      setPersisted(recovered.originPersisted);
    }
    return () => {
      pending.current?.controller.abort();
      pending.current = null;
    };
  }, []);
  useEffect(() => {
    const operation = pending.current;
    const active = current.current;
    if (!operation || !active || targetThread(operation.effect) === threadId) return;
    operation.controller.abort();
    pending.current = null;
    publish({ ...active, trip: interruptMessageReadingTrip(active.trip) });
  }, [publish, threadId]);
  useEffect(() => {
    if (available) return;
    setOpen(false);
    const active = current.current;
    if (!pending.current || !active) return;
    pending.current.controller.abort();
    pending.current = null;
    publish({ ...active, trip: interruptMessageReadingTrip(active.trip) });
  }, [available, publish]);

  const openSearch = useCallback(() => {
    if (!availableNow.current) return;
    entryFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpen(true);
  }, [available]);
  const closeSearch = useCallback(() => {
    setOpen(false);
    entryFocus.current?.focus({ preventScroll: true });
  }, []);
  return {
    open,
    session,
    persisted,
    notice,
    openSearch,
    closeSearch,
    registerReadingPort,
    navigateResult,
    moveTo,
    returnToOrigin,
  };
}
