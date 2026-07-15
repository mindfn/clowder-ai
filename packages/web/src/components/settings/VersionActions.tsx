'use client';

/**
 * F257 Phase D — Version lifecycle action buttons.
 *
 * Provides operator actions for the lifeline view:
 *   - Activate: switch to a specific version
 *   - Enable/Disable: toggle hook override state
 *   - Rollback: revert to manifest baseline (v1)
 *
 * Uses window.prompt for audit reason (avoids modal-in-modal).
 * API calls via apiFetch; parent refreshes data on success.
 */

import { useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { SettingsText } from './primitives';

export interface VersionActionsProps {
  hookId: string;
  onRefresh: () => void;
}

interface ActionButtonProps {
  label: string;
  tone: 'emerald' | 'red' | 'amber' | 'slate';
  hookId: string;
  action: () => Promise<Response>;
  confirmMsg?: string;
  onRefresh: () => void;
}

function ActionButton({ label, tone, action, confirmMsg, onRefresh }: ActionButtonProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toneClasses: Record<string, string> = {
    emerald: 'bg-emerald-600 hover:bg-emerald-700 text-white',
    red: 'bg-red-600 hover:bg-red-700 text-white',
    amber: 'bg-amber-600 hover:bg-amber-700 text-white',
    slate: 'bg-slate-600 hover:bg-slate-700 text-white',
  };

  const handleClick = async () => {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await action();
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError((body as { error?: string }).error ?? `操作失败 (${res.status})`);
        return;
      }
      onRefresh();
    } catch {
      setError('网络错误');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <button
        type="button"
        className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${toneClasses[tone]}`}
        disabled={busy}
        onClick={handleClick}
      >
        {busy ? '处理中...' : label}
      </button>
      {error && (
        <SettingsText as="p" variant="xs" tone="red" className="mt-1">
          {error}
        </SettingsText>
      )}
    </div>
  );
}

/** Action: activate a specific version. */
export function ActivateVersionButton({
  hookId,
  epochVersion,
  onRefresh,
}: VersionActionsProps & { epochVersion: number }) {
  return (
    <ActionButton
      label={`激活 v${epochVersion}`}
      tone="emerald"
      hookId={hookId}
      confirmMsg={`确认激活版本 v${epochVersion}？`}
      action={() => {
        const reason = window.prompt('操作原因（审计追踪）：') ?? '手动激活';
        return apiFetch(`/api/prompt-hooks/${encodeURIComponent(hookId)}/versions/activate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ epochVersion, reason }),
        });
      }}
      onRefresh={onRefresh}
    />
  );
}

/** Action: enable or disable override. */
export function ToggleOverrideButton({
  hookId,
  currentlyEnabled,
  onRefresh,
}: VersionActionsProps & { currentlyEnabled: boolean }) {
  const action = currentlyEnabled ? 'disable' : 'enable';
  const label = currentlyEnabled ? '禁用' : '启用';
  return (
    <ActionButton
      label={label}
      tone={currentlyEnabled ? 'red' : 'emerald'}
      hookId={hookId}
      confirmMsg={currentlyEnabled ? '确认禁用此段？禁用后段内容不再注入。' : undefined}
      action={() => {
        const reason = window.prompt('操作原因（审计追踪）：') ?? `手动${label}`;
        return apiFetch(`/api/prompt-hooks/${encodeURIComponent(hookId)}/override`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, reason }),
        });
      }}
      onRefresh={onRefresh}
    />
  );
}

/** Action: rollback to manifest baseline (v1). */
export function RollbackButton({ hookId, onRefresh }: VersionActionsProps) {
  return (
    <ActionButton
      label="回滚至基线"
      tone="amber"
      hookId={hookId}
      confirmMsg="确认回滚到基线版本 (v1)？所有自定义内容将失效。"
      action={() => {
        const reason = window.prompt('操作原因（审计追踪）：') ?? '手动回滚';
        return apiFetch(`/api/prompt-hooks/${encodeURIComponent(hookId)}/override`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'rollback', reason }),
        });
      }}
      onRefresh={onRefresh}
    />
  );
}
