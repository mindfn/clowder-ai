/**
 * ActionRenderer — generic connector action state machine renderer (AC-A26)
 *
 * Replaces WeixinQrPanel / FeishuQrPanel / WeComBotSetupPanel with a single
 * data-driven component that renders from YAML manifest action definitions.
 *
 * Render types: button, polling, img, status
 * State machine: reads currentAction from operation state, advances via action endpoint.
 */

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { type PlatformActionDef, type PlatformOperationStatus } from '../../HubConfigIcons';
import { ActionPanelBody, type ActionPhase, ConnectedBanner, type ResultState } from './ActionRendererParts';

export interface ActionRendererProps {
  connectorId: string;
  /** Operation definition + state from the status API. */
  operation: PlatformOperationStatus;
  /** Called after connect/disconnect lifecycle completes. */
  onStatusChange?: () => void;
  /** Platform theme color for the primary action button. */
  themeColor?: string;
}

interface ActionApiResult {
  ok: boolean;
  render?: string;
  data?: unknown;
  label?: string;
}

function toResultState(r: ActionApiResult): ResultState {
  return { render: r.render ?? 'status', data: r.data, label: r.label };
}

/** Determine what phase to enter when we land on a given action. */
function phaseForAction(
  actionId: string | undefined,
  actions: PlatformActionDef[],
  disconnectId: string | undefined,
): ActionPhase {
  if (!actionId) return 'idle';
  if (disconnectId && actionId === disconnectId) return 'connected';
  const action = actions.find((a) => a.id === actionId);
  if (action?.render === 'polling') return 'polling';
  return 'idle';
}

/** Classify a poll response into retry / continue / done with parsed state. */
type PollVerdict =
  | { outcome: 'retry' }
  | { outcome: 'continue'; state: ResultState }
  | { outcome: 'done'; state: ResultState };

function classifyPollResult(raw: ActionApiResult | null, actionRender?: string): PollVerdict {
  if (!raw || !raw.ok) return { outcome: 'retry' };
  const state = toResultState(raw);
  if (raw.render === 'polling' || raw.render === actionRender) return { outcome: 'continue', state };
  return { outcome: 'done', state };
}

// ── Main component ──

export function ActionRenderer({ connectorId, operation, onStatusChange, themeColor }: ActionRendererProps) {
  const actions = operation.actions;
  const firstAction = actions[0];
  const disconnectAction = actions.find((a) => a.id === 'disconnect' || a.next === firstAction?.id);
  const disconnectId = disconnectAction?.id;

  const [phase, setPhase] = useState<ActionPhase>(() => {
    const initial = phaseForAction(operation.currentAction, actions, disconnectId);
    return initial === 'idle' && operation.lastResult ? 'result' : initial;
  });
  const [lastResult, setLastResult] = useState<ResultState | undefined>(operation.lastResult);
  const [currentActionId, setCurrentActionId] = useState(operation.currentAction ?? firstAction?.id);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const expireRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortedRef = useRef(false);

  const stopTimers = useCallback(() => {
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }
    if (expireRef.current) {
      clearTimeout(expireRef.current);
      expireRef.current = null;
    }
  }, []);

  useEffect(() => () => stopTimers(), [stopTimers]);

  const autoStartedRef = useRef(false);

  const executeAction = useCallback(
    async (actionId: string): Promise<ActionApiResult | null> => {
      try {
        const url = `/api/connectors/${encodeURIComponent(connectorId)}/actions/${encodeURIComponent(operation.name)}/${encodeURIComponent(actionId)}`;
        const res = await apiFetch(url, { method: 'POST' });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          return { ok: false, label: (err as { error?: string }).error ?? 'Request failed' };
        }
        return (await res.json()) as ActionApiResult;
      } catch {
        return { ok: false, label: 'Network error' };
      }
    },
    [connectorId, operation.name],
  );

  /** Transition to the next action's phase after a successful result. */
  const advanceTo = useCallback(
    (nextId: string) => {
      setCurrentActionId(nextId);
      setPhase(phaseForAction(nextId, actions, disconnectId));
      onStatusChange?.();
    },
    [actions, disconnectId, onStatusChange],
  );

  const startPolling = useCallback(
    (actionId: string, intervalMs = 2500) => {
      stopTimers();
      abortedRef.current = false;

      const action = actions.find((a) => a.id === actionId);
      const timeoutMs = (action?.timeout ?? 60) * 1000;

      const poll = async () => {
        if (abortedRef.current) return;
        const result = await executeAction(actionId);
        if (abortedRef.current) return;

        const verdict = classifyPollResult(result, action?.render);
        if (verdict.outcome === 'retry') {
          pollRef.current = setTimeout(poll, intervalMs);
          return;
        }
        if (verdict.outcome === 'continue') {
          // P1-2 fix: don't overwrite img result with bare polling status —
          // only update lastResult if the poll carries visual data (e.g. label change)
          if (verdict.state.render !== 'polling' && verdict.state.render !== 'status') {
            setLastResult(verdict.state);
          }
          pollRef.current = setTimeout(poll, intervalMs);
          return;
        }
        // done — always update result
        setLastResult(verdict.state);
        stopTimers();
        if (action?.next) advanceTo(action.next);
      };

      pollRef.current = setTimeout(poll, 100);
      expireRef.current = setTimeout(() => {
        abortedRef.current = true;
        stopTimers();
        if (action?.rollback) {
          setCurrentActionId(action.rollback);
          setPhase('idle');
          setErrorMsg('Operation timed out. Please try again.');
        }
      }, timeoutMs);
    },
    [actions, advanceTo, executeAction, stopTimers],
  );

  // P1-3 fix: auto-resume polling when mounted with persisted polling state
  useEffect(() => {
    if (phase === 'polling' && currentActionId && !autoStartedRef.current && !pollRef.current) {
      autoStartedRef.current = true;
      startPolling(currentActionId);
    }
  }, [phase, currentActionId, startPolling]);

  const handleAction = useCallback(
    async (actionId: string) => {
      const action = actions.find((a) => a.id === actionId);
      if (!action) return;

      setPhase('loading');
      setErrorMsg(null);
      const result = await executeAction(actionId);

      if (!result || !result.ok) {
        setPhase('error');
        setErrorMsg(result?.label ?? 'Action failed');
        return;
      }
      setLastResult(toResultState(result));

      // If next action is polling, start polling loop
      const nextDef = action.next ? actions.find((a) => a.id === action.next) : null;
      if (nextDef?.render === 'polling') {
        setCurrentActionId(nextDef.id);
        setPhase('polling');
        startPolling(nextDef.id);
      } else if (action.next) {
        advanceTo(action.next);
      } else {
        setPhase('result');
      }
    },
    [actions, advanceTo, executeAction, startPolling],
  );

  const handleDisconnect = useCallback(async () => {
    if (!disconnectAction) return;
    setPhase('disconnecting');
    setErrorMsg(null);

    const result = await executeAction(disconnectAction.id);
    if (!result || !result.ok) {
      setPhase('connected');
      return;
    }
    setCurrentActionId(firstAction?.id ?? '');
    setLastResult(undefined);
    setPhase('idle');
    onStatusChange?.();
  }, [disconnectAction, executeAction, firstAction, onStatusChange]);

  // ── Dispatch to the appropriate sub-view ──

  if (phase === 'connected' || phase === 'disconnecting') {
    return (
      <ConnectedBanner
        connectorId={connectorId}
        label={lastResult?.label ?? 'Connected'}
        disconnectLabel={disconnectAction?.label}
        disconnecting={phase === 'disconnecting'}
        onDisconnect={disconnectAction ? handleDisconnect : undefined}
      />
    );
  }

  const currentAction = actions.find((a) => a.id === currentActionId) ?? firstAction;

  return (
    <ActionPanelBody
      connectorId={connectorId}
      phase={phase}
      currentAction={currentAction}
      lastResult={lastResult}
      errorMsg={errorMsg}
      themeColor={themeColor}
      onAction={handleAction}
    />
  );
}
