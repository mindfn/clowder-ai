'use client';

import { BindNewSessionSection } from '../BindNewSessionSection';
import { CloudConversationLink } from '../CloudConversationLink';
import { PlanBoardPanel } from '../PlanBoardPanel';
import {
  RevealWhispersButton,
  type RightStatusPanelProps,
  RuntimeLogsButton,
  ThinkingModeToggle,
} from '../RightStatusPanel';
import { SessionIdTag } from '../SessionChainInputs';
import type { SessionChainProjection } from '../SessionChainPanel';
import { modeLabel } from '../status-helpers';
import { ActivityRecordToggle } from './ActivityRecordToggle';

export function StatusDetailsV2({ props, owner }: { props: RightStatusPanelProps; owner: SessionChainProjection }) {
  const { threadId, messageSummary } = props;
  return (
    <div className="status-v2-details">
      <section className="status-v2-section">
        <h3>对话信息</h3>
        <dl>
          <div>
            <dt>对话 ID</dt>
            <dd>
              <SessionIdTag id={threadId} label="对话 ID" />
            </dd>
          </div>
          <div>
            <dt>模式</dt>
            <dd>{modeLabel(props.intentMode)}</dd>
          </div>
          <div>
            <dt>消息</dt>
            <dd>
              共 {messageSummary.total} · 猫猫 {messageSummary.assistant} · 系统 {messageSummary.system} · 证据{' '}
              {messageSummary.evidence} · 跟进 {messageSummary.followup}
            </dd>
          </div>
        </dl>
        <RuntimeLogsButton threadId={threadId} compact />
        {threadId !== 'default' && owner.loadError?.kind !== 'access_denied' && (
          <>
            <CloudConversationLink threadId={threadId} compact />
            <BindNewSessionSection
              threadId={threadId}
              activeCatIds={
                new Set(owner.sessions.filter((session) => session.status === 'active').map((session) => session.catId))
              }
              disabled={owner.isStale}
              onBound={owner.onRefresh}
            />
          </>
        )}
      </section>
      <section className="status-v2-section status-v2-controls">
        <h3>
          显示 <span>仅影响本对话的显示，不影响猫猫收到的内容</span>
        </h3>
        {/* 思考过程 is gone here: in the new shell the thinking is a row inside each reply's execution record. */}
        <ActivityRecordToggle threadId={threadId} />
      </section>
      <section className="status-v2-section status-v2-controls">
        <h3>
          可见性 <span>影响猫猫之间能看到的内容</span>
        </h3>
        <ThinkingModeToggle threadId={threadId} v2 />
        <RevealWhispersButton threadId={threadId} v2 />
      </section>
      <PlanBoardPanel threadId={threadId} catInvocations={props.catInvocations} />
    </div>
  );
}
