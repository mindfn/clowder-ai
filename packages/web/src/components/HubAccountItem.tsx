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
  if (profile.builtin) return null;
  const host = profile.baseUrl?.replace(/^https?:\/\//, '') ?? '(未设置)';
  return `${host} · ${profile.hasApiKey ? '已配置' : '未配置'}`;
}

export function HubAccountItem({ profile, onEdit }: HubAccountItemProps) {
  const statusLabel = profile.hasApiKey ? '已配置' : profile.builtin ? '内置' : '未配置';
  const statusClass =
    profile.hasApiKey || profile.builtin ? 'bg-[#DFF4E7] text-[#087A3E]' : 'bg-[#F3E1D6] text-cafe-secondary';
  const actionLabel = profile.builtin ? '预览 →' : '预览 / 编辑 →';
  const actionColor = profile.builtin ? 'text-cafe-secondary' : 'text-[#6F3A2C]';

  return (
    <button
      type="button"
      className={`flex h-24 w-full items-center gap-4 rounded-2xl bg-[var(--console-card-bg)] px-5 py-[18px] text-left shadow-[0_8px_24px_rgba(43,33,26,0.05)] transition ${onEdit ? 'cursor-pointer hover:shadow-[0_8px_24px_rgba(43,33,26,0.09)]' : ''}`}
      onClick={() => onEdit?.(profile)}
    >
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-bold text-cafe">{profile.displayName}</p>
        <p className="mt-1 text-[12px] text-cafe-secondary truncate">
          {summaryText(profile) ?? (profile.authType === 'oauth' ? 'OAuth' : 'API Key')}
        </p>
      </div>
      <span className={`shrink-0 rounded-md px-2 py-1 text-[11px] font-semibold ${statusClass}`}>{statusLabel}</span>
      <span className={`shrink-0 text-[12px] font-bold ${actionColor}`}>{actionLabel}</span>
    </button>
  );
}
