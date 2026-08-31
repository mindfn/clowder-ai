'use client';

import { useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { BrakeSettingsPanel } from '../BrakeSettingsPanel';
import { HubAgentSessionsTab } from '../HubAgentSessionsTab';
import { HubClaudeRescueSection } from '../HubClaudeRescueSection';
import { HubCommandsTab } from '../HubCommandsTab';
import { HubGovernanceTab } from '../HubGovernanceTab';
import { HubLeaderboardTab } from '../HubLeaderboardTab';
import { HubObservabilityTab } from '../HubObservabilityTab';
import { HubRoutingPolicyTab } from '../HubRoutingPolicyTab';
import { HubRuntimeSessionsTab } from '../HubRuntimeSessionsTab';
import { HubToolUsageTab } from '../HubToolUsageTab';
import { DEFAULT_OPS_SUBSECTION, OPS_SUBSECTIONS } from './ops-nav-config';

const OPS_TABS = OPS_SUBSECTIONS.map((s) => ({ key: s.id, label: s.label }));

export function OpsContent() {
  const searchParams = useSearchParams();
  const opsParam = searchParams.get('ops');
  const obsRaw = searchParams.get('obs');
  const invocationId = searchParams.get('invocationId') ?? undefined;
  const OBS_VALID: ReadonlySet<string> = new Set(['overview', 'traces', 'health', 'callback-auth', 'eval']);
  const obsParam =
    obsRaw && OBS_VALID.has(obsRaw) ? (obsRaw as 'overview' | 'traces' | 'health' | 'callback-auth' | 'eval') : null;
  const validOpsParam = useMemo(
    () => (opsParam && OPS_SUBSECTIONS.some((s) => s.id === opsParam) ? opsParam : null),
    [opsParam],
  );
  const [activeTab, setActiveTab] = useState(validOpsParam ?? DEFAULT_OPS_SUBSECTION);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (validOpsParam) {
      setActiveTab(validOpsParam);
      setNonce((n) => n + 1);
    }
  }, [validOpsParam]);

  return (
    <div>
      <nav className="flex console-divider-b mb-5">
        {OPS_TABS.map((tab) => {
          const isActive = tab.key === activeTab;
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              className={`inline-flex items-center px-5 py-2.5 text-sm font-semibold transition-colors ${
                isActive
                  ? 'border-b-2 border-[var(--console-button-emphasis)] text-[var(--console-button-emphasis)]'
                  : 'text-cafe-muted hover:text-cafe-secondary'
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </nav>
      <OpsSubsectionContent subsection={activeTab} obsSubTab={obsParam} nonce={nonce} invocationId={invocationId} />
    </div>
  );
}

function AuditLogPrivacyToggle() {
  const [value, setValue] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/config/env-summary')
      .then(async (res) => {
        if (!res.ok) return;
        const body = (await res.json()) as { variables: Array<{ name: string; currentValue: string | null }> };
        if (cancelled) return;
        const def = body.variables.find((v) => v.name === 'AUDIT_LOG_INCLUDE_PROMPT_SNIPPETS');
        setValue(def?.currentValue === 'true');
      })
      .catch(() => {
        if (!cancelled) setValue(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleToggle = async () => {
    if (value === null || saving) return;
    const next = !value;
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch('/api/config/env', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates: [{ name: 'AUDIT_LOG_INCLUDE_PROMPT_SNIPPETS', value: String(next) }] }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? '保存失败');
        return;
      }
      setValue(next);
    } catch {
      setError('保存失败');
    } finally {
      setSaving(false);
    }
  };

  const enabled = value === true;

  return (
    <div className="console-list-card rounded-xl p-5 shadow-[0_8px_22px_rgba(43,33,26,0.04)]">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-cafe-secondary">审计日志包含 Prompt 片段</h3>
          <p className="mt-0.5 text-xs text-cafe-muted">
            开启后，审计日志会记录 prompt 片段；关闭后仅保留元数据，不保留具体内容。
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          disabled={value === null || saving}
          onClick={handleToggle}
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
            enabled ? 'bg-conn-emerald-text' : 'bg-cafe-surface-sunken'
          } ${value === null || saving ? 'opacity-60 cursor-not-allowed' : ''}`}
        >
          <span
            className={`inline-block h-3.5 w-3.5 rounded-full bg-cafe-white transition-transform ${
              enabled ? 'translate-x-4' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-conn-red-text">{error}</p>}
    </div>
  );
}

function OpsSubsectionContent({
  subsection,
  obsSubTab,
  nonce,
  invocationId,
}: {
  subsection: string;
  obsSubTab?: 'overview' | 'traces' | 'health' | 'callback-auth' | 'eval' | null;
  nonce: number;
  invocationId?: string;
}) {
  switch (subsection) {
    case 'usage':
      return (
        <div className="space-y-6">
          <HubRoutingPolicyTab />
          <HubToolUsageTab />
        </div>
      );
    case 'leaderboard':
      return <HubLeaderboardTab />;
    case 'observability':
      return (
        <HubObservabilityTab
          initialSubTab={obsSubTab ?? undefined}
          subTabNonce={nonce}
          initialInvocationId={invocationId}
        />
      );
    case 'agent-sessions':
      return <HubAgentSessionsTab />;
    case 'runtime-sessions':
      return <HubRuntimeSessionsTab />;
    case 'health':
      return (
        <div className="space-y-6">
          <AuditLogPrivacyToggle />
          <HubGovernanceTab />
          <BrakeSettingsPanel />
        </div>
      );
    case 'commands':
      return <HubCommandsTab />;
    case 'rescue':
      return <HubClaudeRescueSection />;
    default:
      return null;
  }
}
