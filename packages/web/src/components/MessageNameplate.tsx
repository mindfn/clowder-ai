'use client';

import { Nameplate } from '@cat-cafe/ui';
import type { SenderMeta } from '@/lib/resolve-sender';
import { SenderAvatar } from './SenderAvatar';

interface MessageNameplateProps {
  id: string;
  name: string;
  title?: string;
  surface: string;
  ink: string;
  sender: SenderMeta;
  onClick?: () => void;
  kind?: 'cat' | 'member';
}

/** Shared member identity plate; cats and plugins provide identity, not shell markup. */
export function MessageNameplate({
  id,
  name,
  title,
  surface,
  ink,
  sender,
  onClick,
  kind = 'member',
}: MessageNameplateProps) {
  return (
    <Nameplate
      id={id}
      name={name}
      title={title}
      surface={surface}
      ink={ink}
      kind={kind}
      avatar={<SenderAvatar sender={sender} presentation="nameplate" onClick={onClick} />}
    />
  );
}
