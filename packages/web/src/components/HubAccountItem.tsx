'use client';

import type { ProfileItem } from './hub-accounts.types';
import { HubIcon } from './hub-icons';

export interface ProfileEditPayload {
  displayName: string;
  baseUrl?: string;
  apiKey?: string;
  models?: string[];
  modelOverride?: string | null;
}

interface HubAccountItemProps {
  profile: ProfileItem;
  busy: boolean;
  onSave: (profileId: string, payload: ProfileEditPayload) => Promise<void>;
  onDelete: (profileId: string) => void;
  onEdit?: (profile: ProfileItem) => void;
}

function summaryText(profile: ProfileItem): string | null {
  if (profile.builtin) return profile.authType === 'oauth' ? 'OAuth' : '内置';
  const host = profile.baseUrl?.replace(/^https?:\/\//, '') ?? '(未设置)';
  return `${host} · ${profile.authType === 'oauth' ? 'OAuth' : 'API Key'}`;
}

export function HubAccountItem({ profile, busy, onDelete, onEdit }: HubAccountItemProps) {
  return (
    <div className="flex w-full items-center gap-4 rounded-xl bg-[var(--console-card-bg)] p-4 transition-colors hover:bg-[var(--console-card-soft-bg)]">
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-bold text-cafe">{profile.displayName}</p>
        <p className="mt-1 text-[12px] text-cafe-secondary truncate">{summaryText(profile)}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {onEdit && (
          <button
            type="button"
            onClick={() => onEdit(profile)}
            className="rounded-md p-1.5 text-cafe-muted hover:bg-[var(--console-card-soft-bg)] hover:text-cafe-secondary transition-colors"
            title="编辑"
          >
            <HubIcon name="pencil" className="h-3.5 w-3.5" />
          </button>
        )}
        {!profile.builtin && onDelete && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onDelete(profile.id)}
            className={`rounded-md p-1.5 text-cafe-muted hover:bg-[var(--console-card-soft-bg)] hover:text-[var(--console-stop,#f26767)] transition-colors ${busy ? 'opacity-50' : ''}`}
            title="删除"
          >
            <HubIcon name="trash" className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}
