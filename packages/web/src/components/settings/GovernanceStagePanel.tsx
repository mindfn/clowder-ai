'use client';

/** F257 Phase D — Governance stage detail panel with operation actions. */

import { SettingsBadge, SettingsText } from './primitives';
import { RollbackButton, ToggleOverrideButton } from './VersionActions';

interface GuardEvent {
  eventId: string;
  kind: string;
  threadId: string;
  catId: string;
  timestamp: number;
  guardId: string;
  /** Attribution hint: guard events are window-correlated, not causally linked. */
  attribution?: 'window-correlated';
}

export interface GovernanceStagePanelProps {
  version: number;
  governance: { decision: string | null; decidedAt: number | null; actorId: string | null } | null;
  guardEvents: GuardEvent[];
  overrideState: { hookId: string; enabled: boolean } | null;
  hookId: string;
  onRefresh: () => void;
}

const formatTs = (ms: number) => new Date(ms).toLocaleString();

export function GovernanceStagePanel({
  version,
  governance,
  guardEvents,
  overrideState,
  hookId,
  onRefresh,
}: GovernanceStagePanelProps) {
  /** P1-4: null overrideState = default enabled (manifest baseline, no override record yet). */
  const effectiveEnabled = overrideState?.enabled ?? true;

  return (
    <>
      <SettingsText as="h3" variant="sm" tone="default" className="mb-3 font-semibold">
        v{version} — Governance
      </SettingsText>

      <div className="mb-3">
        <InfoRow label="当前状态">
          <SettingsBadge tone={effectiveEnabled ? 'emerald' : 'red'} size="xxs">
            {effectiveEnabled ? '已启用' : '已禁用'}
          </SettingsBadge>
          {!overrideState && <span className="ml-2 text-xs text-cafe-muted">（默认）</span>}
        </InfoRow>
      </div>

      {governance?.decision ? (
        <InfoRow label="决策">
          <SettingsBadge tone={governance.decision === 'approved' ? 'emerald' : 'amber'} size="xxs">
            {governance.decision}
          </SettingsBadge>
          {governance.decidedAt && (
            <span className="ml-2 text-xs text-cafe-muted">{formatTs(governance.decidedAt)}</span>
          )}
        </InfoRow>
      ) : (
        <div className="flex flex-col items-center gap-2 py-6 opacity-40">
          <span className="text-2xl">{'🛡️'}</span>
          <SettingsText as="p" variant="xs" tone="muted">
            等待治理决策
          </SettingsText>
        </div>
      )}

      <div className="mt-4 flex gap-2">
        <ToggleOverrideButton hookId={hookId} currentlyEnabled={effectiveEnabled} onRefresh={onRefresh} />
        <RollbackButton hookId={hookId} onRefresh={onRefresh} />
      </div>

      {guardEvents.length > 0 && (
        <div className="mt-4">
          <SettingsText as="h4" variant="xs" tone="muted" className="mb-2 font-semibold">
            守卫事件 ({guardEvents.length})
          </SettingsText>
          {guardEvents[0]?.attribution === 'window-correlated' && (
            <SettingsText as="p" variant="xs" tone="muted" className="mb-2 italic">
              时间窗口关联，非因果归因
            </SettingsText>
          )}
          <div className="max-h-[160px] space-y-1 overflow-y-auto">
            {guardEvents.map((ev) => (
              <Row key={ev.eventId} ts={ev.timestamp}>
                <SettingsBadge tone="red" size="xxs">
                  {ev.kind}
                </SettingsBadge>
                <span className="text-cafe-secondary">@{ev.catId}</span>
                <span className="ml-auto font-mono text-cafe-muted">{ev.guardId}</span>
              </Row>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-[80px] shrink-0 text-cafe-muted">{label}</span>
      <span className="text-cafe">{children}</span>
    </div>
  );
}

function Row({ ts, children }: { ts: number; children: React.ReactNode }) {
  return (
    <div
      className="flex items-center gap-3 rounded-lg px-2 py-1.5 text-xs hover:brightness-95"
      style={{ backgroundColor: 'var(--console-elevated-bg)' }}
    >
      <span className="w-[120px] shrink-0 font-mono text-cafe-muted">{formatTs(ts)}</span>
      {children}
    </div>
  );
}
