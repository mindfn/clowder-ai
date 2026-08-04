'use client';

import { useState } from 'react';
import { SettingsBadge, SettingsText } from './primitives';
import { SegmentReplayPanel } from './SegmentReplayPanel';

export interface TraceTheaterObservation {
  threadId: string;
  turnId: string;
  timestamp: number;
  catId: string;
  pipelineStatus: string;
  version: number | null;
  charCount: number;
}

export function SegmentTraceTheater({
  segmentId,
  observations,
  capped,
}: {
  segmentId: string;
  observations: TraceTheaterObservation[];
  capped?: boolean;
}) {
  const [selected, setSelected] = useState<TraceTheaterObservation | null>(null);
  return (
    <div className="space-y-2" data-testid="segment-trace-theater">
      <SettingsText as="p" variant="xs" tone="muted">
        点击记录查看 Tracing 详情
      </SettingsText>
      {observations.length === 0 ? (
        <SettingsText as="p" variant="xs" tone="muted">
          暂无 Tracing 记录
        </SettingsText>
      ) : (
        <div className="space-y-1.5">
          {observations.map((observation) => (
            <button
              type="button"
              key={`${observation.threadId}:${observation.turnId}`}
              onClick={() => setSelected(observation)}
              className="flex w-full items-center gap-3 rounded-xl bg-[var(--console-panel-bg)] px-3 py-2.5 text-left transition hover:brightness-95"
            >
              <span className="w-[132px] shrink-0 text-xs text-cafe-secondary">
                {new Date(observation.timestamp).toLocaleString()}
              </span>
              <SettingsBadge tone={observation.pipelineStatus === 'fired' ? 'emerald' : 'slate'} size="xxs">
                {observation.pipelineStatus === 'fired' ? '已注入' : '已观测'}
              </SettingsBadge>
              <span className="min-w-0 flex-1 truncate text-xs text-cafe-secondary">@{observation.catId}</span>
              <span className="shrink-0 text-micro text-cafe-muted">{observation.charCount} chars</span>
              <span className="shrink-0 text-xs text-cafe-muted" aria-hidden="true">
                ›
              </span>
            </button>
          ))}
        </div>
      )}
      {capped && (
        <SettingsText as="p" variant="xs" tone="muted">
          当前仅展示最近 100 场；窗口总计数仍为完整聚合。
        </SettingsText>
      )}
      {selected && (
        <SegmentReplayPanel
          segmentId={segmentId}
          threadId={selected.threadId}
          turnId={selected.turnId}
          timestamp={selected.timestamp}
          catId={selected.catId}
          pipelineStatus={selected.pipelineStatus}
          isOpen
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
