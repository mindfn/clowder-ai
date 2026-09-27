/**
 * OperationRowsRenderer — an operation whose list action returns a `rows` result (F202 W2-3 h1).
 *
 * Each row shows its label and detail and the actions the Host validated for it. A row action
 * calls the plugin with that row's input; a declared confirmation is asked first in the shared
 * Console dialog; the row being acted on is disabled while it runs and shows its own error. An
 * action whose `next` is the list action refreshes the list when it succeeds.
 */

'use client';

import type { PluginOperationRow, PluginOperationRowAction, PluginOperationRows } from '@cat-cafe/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import type { PlatformActionDef } from '../../HubConfigIcons';
import type { ActionRendererProps } from './ActionRenderer';
import { type ActionApiResult, actionCallFailure, actionRequest, rowActionRequest } from './ActionRendererState';
import { useActionConfirmation } from './actionConfirmation';

/** The Host has already validated a rows result against the manifest; this only reads its shape. */
function rowsFrom(result: { render?: string; data?: unknown } | undefined): PluginOperationRows | undefined {
  if (result?.render !== 'rows' || result.data === null || typeof result.data !== 'object') return undefined;
  return Array.isArray((result.data as { rows?: unknown }).rows) ? (result.data as PluginOperationRows) : undefined;
}

const buttonClass =
  'rounded-lg border border-cafe-border px-3 py-1.5 text-xs font-medium text-cafe-secondary hover:bg-cafe-surface-sunken disabled:opacity-50';

export function OperationRowsRenderer({
  target,
  operation,
  onStatusChange,
  listAction,
}: ActionRendererProps & { listAction: PlatformActionDef }) {
  const stableTarget = useMemo(() => ({ kind: target.kind, id: target.id }) as typeof target, [target.kind, target.id]);
  const [rows, setRows] = useState<PluginOperationRows | undefined>(() => rowsFrom(operation.lastResult));
  const [listing, setListing] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [rowErrors, setRowErrors] = useState<Readonly<Record<string, string>>>({});
  const confirmAction = useActionConfirmation();
  const listRequestId = useRef(0);

  const post = useCallback(async (request: { url: string; init: RequestInit }): Promise<ActionApiResult> => {
    try {
      const response = await apiFetch(request.url, request.init);
      const body = (await response.json().catch(() => ({}))) as ActionApiResult & { error?: string };
      if (!response.ok) return { ok: false, label: body.error ?? 'Request failed' };
      return body;
    } catch {
      return { ok: false, label: 'Network error' };
    }
  }, []);

  const list = useCallback(async () => {
    const id = ++listRequestId.current;
    setListing(true);
    setListError(null);
    const result = await post(actionRequest(stableTarget, operation.name, listAction.id));
    if (id !== listRequestId.current) return;
    const next = result.ok ? rowsFrom(result) : undefined;
    if (next) setRows(next);
    else setListError(result.label ?? 'The list is unavailable');
    setListing(false);
  }, [listAction.id, operation.name, post, stableTarget]);

  useEffect(() => {
    void list();
  }, [list]);

  const settle = useCallback(
    async (result: ActionApiResult, next: string | undefined): Promise<string | null> => {
      const failure = actionCallFailure(result);
      if (failure !== null) return failure;
      onStatusChange?.();
      if (next === listAction.id) await list();
      return null;
    },
    [list, listAction.id, onStatusChange],
  );

  const runRowAction = useCallback(
    async (row: PluginOperationRow, rowAction: PluginOperationRowAction) => {
      const declared = operation.rowActions?.find((candidate) => candidate.id === rowAction.action);
      if (!declared) return;
      if (!(await confirmAction(rowAction.label ?? declared.label, declared.confirm, rowAction.confirm))) return;
      setBusyKeys((current) => new Set(current).add(row.key));
      setRowErrors(({ [row.key]: _cleared, ...rest }) => rest);
      const result = await post(rowActionRequest(stableTarget, operation.name, declared.id, rowAction.input));
      const failure = await settle(result, declared.next);
      if (failure !== null) setRowErrors((current) => ({ ...current, [row.key]: failure }));
      setBusyKeys((current) => {
        const next = new Set(current);
        next.delete(row.key);
        return next;
      });
    },
    [confirmAction, operation.name, operation.rowActions, post, settle, stableTarget],
  );

  const runButton = useCallback(
    async (action: PlatformActionDef) => {
      if (!(await confirmAction(action.label, action.confirm))) return;
      setListError(null);
      const failure = await settle(await post(actionRequest(stableTarget, operation.name, action.id)), action.next);
      if (failure !== null) setListError(failure);
    },
    [confirmAction, operation.name, post, settle, stableTarget],
  );

  const buttons = operation.actions.filter((action) => action.render === 'button' && action.id !== listAction.id);

  return (
    <div className="space-y-2" data-testid={`${target.id}-rows`}>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={listing}
          onClick={() => void list()}
          className={buttonClass}
          data-testid={`${target.id}-rows-refresh`}
        >
          {listAction.label}
        </button>
        {buttons.map((action) => (
          <button
            key={action.id}
            type="button"
            disabled={listing}
            onClick={() => void runButton(action)}
            className={buttonClass}
            data-testid={`${target.id}-action-${action.id}`}
          >
            {action.label}
          </button>
        ))}
      </div>
      {listError && (
        <p role="alert" className="text-xs text-conn-red-text">
          {listError}
        </p>
      )}
      {rows && rows.rows.length === 0 && (
        <p className="text-sm text-cafe-muted" data-testid={`${target.id}-rows-empty`}>
          {rows.empty ?? 'Nothing to show yet.'}
        </p>
      )}
      {rows && rows.rows.length > 0 && (
        <ul className="divide-y divide-cafe-border rounded-lg border border-cafe-border">
          {rows.rows.map((row) => (
            <li key={row.key} className="px-3 py-2" data-testid={`${target.id}-row-${row.key}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="break-words text-sm font-medium">{row.label}</p>
                  {row.detail && <p className="break-all text-xs text-cafe-secondary">{row.detail}</p>}
                </div>
                <div className="flex shrink-0 gap-2">
                  {(row.actions ?? []).map((rowAction) => {
                    const declared = operation.rowActions?.find((candidate) => candidate.id === rowAction.action);
                    if (!declared) return null;
                    return (
                      <button
                        key={rowAction.action}
                        type="button"
                        disabled={busyKeys.has(row.key)}
                        onClick={() => void runRowAction(row, rowAction)}
                        className={buttonClass}
                        data-testid={`${target.id}-row-${row.key}-action-${rowAction.action}`}
                      >
                        {rowAction.label ?? declared.label}
                      </button>
                    );
                  })}
                </div>
              </div>
              {rowErrors[row.key] && (
                <p
                  role="alert"
                  className="mt-1 text-xs text-conn-red-text"
                  data-testid={`${target.id}-row-${row.key}-error`}
                >
                  {rowErrors[row.key]}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
