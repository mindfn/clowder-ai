'use client';

import type { ProfileItem } from './hub-accounts.types';

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

export function HubAccountItem({ profile, onEdit }: HubAccountItemProps) {
  return (
    <button
      type="button"
      className={`flex w-full items-center gap-4 rounded-xl bg-[var(--console-card-bg)] p-4 text-left transition-colors ${onEdit ? 'cursor-pointer hover:bg-[var(--console-card-soft-bg)]' : ''}`}
      onClick={() => onEdit?.(profile)}
    >
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-bold text-cafe">{profile.displayName}</p>
        <p className="mt-1 text-[12px] text-cafe-secondary truncate">{summaryText(profile)}</p>
      </div>
      {onEdit && (
        <span className="shrink-0 text-xs text-cafe-muted">
          编辑 →
        </span>
      )}
    </button>
  );
}
