'use client';

import { catColorVar } from '@/lib/cat-slug';
import type { ContextHealthData } from '@/stores/chat-types';
import { formatTokenCount } from '../status-helpers';

/** Keep the existing measurement and unit. Token totals are never a context percentage. */
export function SessionContextV2({ catId, health }: { catId: string; health?: ContextHealthData }) {
  if (!health || !Number.isFinite(health.usedTokens) || health.usedTokens < 0) {
    return <p className="status-v2-muted">上下文用量未知</p>;
  }
  if (!Number.isFinite(health.windowTokens) || health.windowTokens <= 0) {
    return <p className="status-v2-muted">上下文 {formatTokenCount(health.usedTokens)} token · 上限未知</p>;
  }
  if (!Number.isFinite(health.fillRatio) || health.fillRatio < 0) {
    return <p className="status-v2-muted">上下文用量未知</p>;
  }
  const percent = Math.round(health.fillRatio * 100);
  const nearLimit = health.fillRatio >= 0.8;
  const estimated = health.source === 'approx' || health.usedFrom === 'input' || health.usedFrom === 'total';
  const source =
    health.usedFrom === 'input'
      ? '输入 token 估算'
      : health.usedFrom === 'total'
        ? '总 token 估算'
        : estimated
          ? '估算'
          : '实测';
  return (
    <div
      className="status-v2-context"
      title={`${source}：${formatTokenCount(health.usedTokens)} / ${formatTokenCount(health.windowTokens)} token`}
    >
      <div
        role="progressbar"
        aria-label="上下文用量"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.min(percent, 100)}
        aria-valuetext={`${estimated ? '约 ' : ''}${percent}%${nearLimit ? '，接近上限' : ''}`}
        data-near-limit={nearLimit}
        className="status-v2-meter"
      >
        <span
          style={{
            width: `${Math.min(percent, 100)}%`,
            background: nearLimit ? 'var(--semantic-warning)' : catColorVar(catId, 'primary'),
          }}
        />
      </div>
      <span className="status-v2-muted">
        {estimated ? '约 ' : ''}
        {percent}%
      </span>
      {nearLimit && (
        <span className="status-v2-limit">
          <span className="status-v2-dot" style={{ background: 'var(--semantic-warning)' }} />
          接近上限
        </span>
      )}
    </div>
  );
}
