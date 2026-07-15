'use client';

/**
 * F257 Phase D — Stage detail panel for lifeline.
 *
 * Shows stage-specific data when a badge is clicked in the chain view:
 *   - version: version info, origin, events
 *   - tracing: observation list with expandable rows
 *   - eval: judgment results or "pending" placeholder
 *   - governance: override history and current state
 */

import { useState } from 'react';
import { EvalStagePanel } from './EvalStagePanel';
import type { SelectedStage } from './LifelineChainView';
import { SettingsBadge, SettingsText } from './primitives';

// ── Types (matching API response) ──────────────────────────────

interface VersionEpoch {
  version: number;
  origin: string;
  startedAt: number;
  status: string;
  isActive: boolean;
  tracing: { observationCount: number; firstAt: number | null; lastAt: number | null } | null;
  eval: { verdict: string | null; injectionCount: number; violationCount: number; evaluatedAt: number | null } | null;
  governance: { decision: string | null; decidedAt: number | null; actorId: string | null } | null;
  events: Array<{ eventId: string; kind: string; timestamp: number; actorId: string; detail: string }>;
}

interface Observation {
  threadId: string;
  turnId: string;
  timestamp: number;
  catId: string;
  pipelineStatus: string;
  version: number | null;
  charCount: number;
}

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

interface LifelineStageDetailProps {
  selected: SelectedStage;
  chain: VersionEpoch[];
  observations: Observation[];
  guardEvents: GuardEvent[];
  overrideState: { hookId: string; enabled: boolean } | null;
}

const formatTs = (ms: number) => new Date(ms).toLocaleString();
const formatRel = (ms: number) => {
  const m = Math.floor((Date.now() - ms) / 60000);
  return m < 60 ? `${m}分钟前` : m < 1440 ? `${Math.floor(m / 60)}小时前` : `${Math.floor(m / 1440)}天前`;
};

export function LifelineStageDetail({
  selected,
  chain,
  observations,
  guardEvents,
  overrideState,
}: LifelineStageDetailProps) {
  const epoch = chain.find((e) => e.version === selected.version);
  if (!epoch) return null;

  return (
    <div className="rounded-2xl p-4" style={{ backgroundColor: 'var(--console-panel-bg)' }}>
      {selected.stage === 'version' && <VersionDetail epoch={epoch} />}
      {selected.stage === 'tracing' && <TracingDetail epoch={epoch} observations={observations} />}
      {selected.stage === 'eval' && (
        <EvalStagePanel
          version={epoch.version}
          eval={epoch.eval}
          tracing={epoch.tracing}
          guardEventCount={guardEvents.length}
        />
      )}
      {selected.stage === 'governance' && (
        <GovernanceDetail epoch={epoch} guardEvents={guardEvents} overrideState={overrideState} />
      )}
    </div>
  );
}

function VersionDetail({ epoch }: { epoch: VersionEpoch }) {
  const originLabel =
    { manifest: '基线', 'auto-iterate': '自动迭代', 'user-create': '用户创建' }[epoch.origin] ?? epoch.origin;

  return (
    <>
      <SettingsText as="h3" variant="sm" tone="default" className="mb-3 font-semibold">
        v{epoch.version} — {originLabel}
      </SettingsText>

      <div className="space-y-2">
        <InfoRow label="状态">
          <StatusBadge status={epoch.status} />
        </InfoRow>
        {epoch.startedAt > 0 && <InfoRow label="创建时间">{formatTs(epoch.startedAt)}</InfoRow>}
        <InfoRow label="当前激活">
          <SettingsBadge tone={epoch.isActive ? 'emerald' : 'slate'} size="xxs">
            {epoch.isActive ? '是' : '否'}
          </SettingsBadge>
        </InfoRow>
      </div>

      {epoch.events.length > 0 && (
        <div className="mt-4">
          <SettingsText as="h4" variant="xs" tone="muted" className="mb-2 font-semibold">
            事件 ({epoch.events.length})
          </SettingsText>
          <div className="space-y-1">
            {epoch.events.map((ev) => (
              <EventRow key={ev.eventId} event={ev} />
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function TracingDetail({ epoch, observations }: { epoch: VersionEpoch; observations: Observation[] }) {
  const versionObs = observations.filter((o) => o.version === epoch.version || o.version == null);

  return (
    <>
      <SettingsText as="h3" variant="sm" tone="default" className="mb-3 font-semibold">
        v{epoch.version} — Tracing
        {epoch.tracing && (
          <span className="ml-2 text-xs font-normal text-cafe-muted">({epoch.tracing.observationCount} 次观测)</span>
        )}
      </SettingsText>

      {epoch.tracing?.firstAt && epoch.tracing.lastAt && (
        <div className="mb-3 space-y-1">
          <InfoRow label="首次观测">{formatRel(epoch.tracing.firstAt)}</InfoRow>
          <InfoRow label="最近观测">{formatRel(epoch.tracing.lastAt)}</InfoRow>
        </div>
      )}

      {versionObs.length > 0 ? (
        <div className="max-h-[240px] space-y-1 overflow-y-auto">
          {versionObs.slice(0, 50).map((obs) => (
            <ObservationRow key={`${obs.threadId}-${obs.turnId}`} obs={obs} />
          ))}
          {versionObs.length > 50 && (
            <SettingsText as="p" variant="xs" tone="muted" className="pt-1 italic">
              还有 {versionObs.length - 50} 条...
            </SettingsText>
          )}
        </div>
      ) : (
        <SettingsText as="p" variant="xs" tone="muted" className="italic">
          该版本无观测数据
        </SettingsText>
      )}
    </>
  );
}

function GovernanceDetail({
  epoch,
  guardEvents,
  overrideState,
}: {
  epoch: VersionEpoch;
  guardEvents: GuardEvent[];
  overrideState: { hookId: string; enabled: boolean } | null;
}) {
  return (
    <>
      <SettingsText as="h3" variant="sm" tone="default" className="mb-3 font-semibold">
        v{epoch.version} — Governance
      </SettingsText>

      {overrideState && (
        <div className="mb-3">
          <InfoRow label="当前状态">
            <SettingsBadge tone={overrideState.enabled ? 'emerald' : 'red'} size="xxs">
              {overrideState.enabled ? '已启用' : '已禁用'}
            </SettingsBadge>
          </InfoRow>
        </div>
      )}

      {epoch.governance?.decision ? (
        <InfoRow label="决策">
          <SettingsBadge tone={epoch.governance.decision === 'approved' ? 'emerald' : 'amber'} size="xxs">
            {epoch.governance.decision}
          </SettingsBadge>
          {epoch.governance.decidedAt && (
            <span className="ml-2 text-xs text-cafe-muted">{formatTs(epoch.governance.decidedAt)}</span>
          )}
        </InfoRow>
      ) : (
        <div className="flex flex-col items-center gap-2 py-6 opacity-40">
          <span className="text-2xl">🛡️</span>
          <SettingsText as="p" variant="xs" tone="muted">
            等待治理决策
          </SettingsText>
        </div>
      )}

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

const STATUS_MAP: Record<string, [string, 'emerald' | 'amber' | 'red' | 'slate']> = {
  idle: ['空闲', 'slate'],
  tracing: ['观测中', 'emerald'],
  'eval-pending': ['待评估', 'amber'],
  'eval-pass': ['评估通过', 'emerald'],
  'eval-reject': ['评估未通过', 'red'],
  'governance-pending': ['待治理', 'amber'],
  'governance-approved': ['治理通过', 'emerald'],
};
function StatusBadge({ status }: { status: string }) {
  const [label, tone] = STATUS_MAP[status] ?? [status, 'slate' as const];
  return (
    <SettingsBadge tone={tone} size="xxs">
      {label}
    </SettingsBadge>
  );
}

const KIND_LABEL: Record<string, string> = {
  'auto-iterate': '自动迭代',
  'user-create': '用户创建',
  'version-activate': '版本切换',
  'user-edit': '用户编辑',
  'eval-pass': '评估通过',
  'eval-reject': '评估未通过',
  'governance-approve': '治理通过',
  'governance-reject': '治理禁用',
};
function EventRow({
  event,
}: {
  event: { eventId: string; kind: string; timestamp: number; actorId: string; detail: string };
}) {
  return (
    <Row ts={event.timestamp}>
      <SettingsBadge tone="amber" size="xxs">
        {KIND_LABEL[event.kind] ?? event.kind}
      </SettingsBadge>
      <span className="text-cafe-secondary">{event.detail}</span>
      <span className="ml-auto text-cafe-muted">@{event.actorId}</span>
    </Row>
  );
}

function ObservationRow({ obs }: { obs: Observation }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div>
      <button type="button" className="w-full text-left" onClick={() => setExpanded((e) => !e)}>
        <Row ts={obs.timestamp}>
          <SettingsBadge tone={obs.pipelineStatus === 'fired' ? 'emerald' : 'slate'} size="xxs">
            {obs.pipelineStatus}
          </SettingsBadge>
          <span className="text-cafe-secondary">@{obs.catId}</span>
          <span className="ml-auto text-cafe-muted">
            {obs.charCount} chars {expanded ? '▾' : '▸'}
          </span>
        </Row>
      </button>
      {expanded && (
        <div className="ml-[132px] space-y-0.5 pb-1 text-xs text-cafe-muted">
          <div>
            Thread: <span className="font-mono">{obs.threadId}</span>
          </div>
          <div>
            Turn: <span className="font-mono">{obs.turnId}</span>
          </div>
          {obs.version != null && <div>Version: v{obs.version}</div>}
        </div>
      )}
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
