'use client';

import type { CatData } from '@/hooks/useCatData';
import { useRoutingContext } from '../routing-context/useRoutingContext';
import { OpenTeamWorkspaceButton } from '../settings/OpenTeamWorkspaceButton';
import { useMemberText } from './editor-presentation';
import { MemberStatus } from './MemberStatus';
import { memberStatus } from './member-projection';
import { useMemberClock } from './useMemberClock';
export function MemberDetailHeader({
  cat,
  toggling,
  onToggle,
}: {
  cat: CatData;
  toggling: boolean;
  onToggle: (cat: CatData) => void;
}) {
  const t = useMemberText();
  const routing = useRoutingContext();
  const now = useMemberClock(routing.data);
  return (
    <div className="member-detail-status">
      <MemberStatus
        status={
          routing.loading && !routing.data
            ? { label: '读取中', detail: '', tone: 'unknown' }
            : memberStatus(cat, routing.data, routing.error, now)
        }
      />
      <label className="member-enable-control">
        <span>{t('启用')}</span>
        <button
          type="button"
          className="member-switch"
          role="switch"
          aria-label={t('启用')}
          aria-checked={cat.roster?.available !== false}
          disabled={toggling}
          onClick={() => onToggle(cat)}
        >
          <span />
        </button>
      </label>
      <OpenTeamWorkspaceButton label={t('打开猫猫团队')} />
    </div>
  );
}
