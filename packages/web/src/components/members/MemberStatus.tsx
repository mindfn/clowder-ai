import { HelpTip } from '../settings/HelpTip';
import { useMembersCopy, useMemberText } from './editor-presentation';
import type { MemberStatus as Status } from './member-projection';
export function MemberStatus({ status }: { status: Status }) {
  const t = useMemberText();
  const copy = useMembersCopy();
  const detail = [
    ...new Set(
      [
        status.detailIsNote ? status.detail : t(status.detail),
        status.source && t(status.source),
        status.until !== undefined && copy.until(status.until),
      ].filter(Boolean),
    ),
  ].join(' · ');
  return (
    <span className="member-status" data-tone={status.tone}>
      <span className="member-status-label">
        <i aria-hidden="true" />
        <span>{t(status.label)}</span>
        {status.label === '已恢复' && status.evidenceRef && (
          <HelpTip topic={copy.recoveryEvidence}>
            <p>{copy.recoveryHelp}</p>
            <p>{copy.evidence(status.evidenceRef)}</p>
            {status.note && <p>{status.note}</p>}
          </HelpTip>
        )}
      </span>
      {detail && <small>{detail}</small>}
      {status.observedAt !== undefined && (
        <small>
          <time dateTime={new Date(status.observedAt).toISOString()}>{copy.observedTime(status.observedAt)}</time>
        </small>
      )}
    </span>
  );
}
