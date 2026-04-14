'use client';

import { CLIENT_OPTIONS, type ClientId } from './hub-cat-editor.model';

/** Template with optional identity + provider/model info from /api/cat-templates */
export interface SeedTemplate {
  id?: string;
  name?: string;
  nickname?: string;
  avatar?: string;
  color?: { primary: string; secondary: string };
  roleDescription?: string;
  personality?: string;
  teamStrengths?: string;
  provider: string;
  source?: string;
  defaultModel?: string;
  commandArgs?: string[];
}

export function TemplatePicker({
  templates,
  selectedId,
  onSelect,
}: {
  templates: SeedTemplate[];
  selectedId?: string;
  onSelect: (template: SeedTemplate | null) => void;
}) {
  const named = templates.filter((t) => t.name);
  if (named.length === 0) return null;
  return (
    <section className="space-y-2 rounded-[20px] border border-[#F1E7DF] bg-[#FFFDFC] p-[18px]" data-guide-id="add-member.template-picker">
      <h4 className="text-[15px] font-bold text-[#2D2118]">模板快选（可选）</h4>
      <div className="flex flex-wrap gap-2">
        {named.map((t) => (
          <button
            key={t.id ?? t.name}
            type="button"
            onClick={() => onSelect(selectedId === t.id ? null : t)}
            className={`rounded-full px-3 py-1.5 text-sm transition ${
              selectedId === t.id ? 'bg-[#D49266] text-white' : 'bg-[#F7EEE6] text-[#5C4B42] hover:bg-[#EDE0D5]'
            }`}
          >
            {t.nickname ?? t.name}
          </button>
        ))}
      </div>
    </section>
  );
}

export const CLIENT_ROW_1: ClientId[] = ['anthropic', 'openai', 'google', 'kimi'];
export const CLIENT_ROW_2: ClientId[] = ['opencode', 'dare', 'antigravity'];
export const FALLBACK_ANTIGRAVITY_ARGS = '. --remote-debugging-port=9000';
export const FALLBACK_ANTIGRAVITY_MODELS = ['gemini-3.1-pro', 'claude-opus-4-6'] as const;

function cardClass(selected: boolean) {
  return selected
    ? 'border-[#D49266] bg-[#F7EEE6] text-[#D49266] shadow-sm'
    : 'border-[#E8DCCF] bg-[#F7F3F0] text-[#5C4B42] hover:border-[#D9C0A8]';
}

export function clientLabel(client: ClientId) {
  return CLIENT_OPTIONS.find((option) => option.value === client)?.label ?? client;
}

export function ChoiceButton({
  label,
  subtitle,
  selected,
  onClick,
}: {
  label: string;
  subtitle?: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`min-h-[74px] w-full rounded-[14px] border px-4 py-3 text-left transition ${cardClass(selected)}`}
    >
      <div className="font-bold">{label}</div>
      {subtitle ? <div className="mt-1 line-clamp-2 text-[12px] leading-5 opacity-80">{subtitle}</div> : null}
    </button>
  );
}

export function PillChoiceButton({
  label,
  selected,
  onClick,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-[12px] border px-4 py-[10px] text-sm font-semibold transition ${cardClass(selected)}`}
    >
      {label}
    </button>
  );
}

export function ModelPillButton({
  label,
  selected,
  onClick,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-[10px] border px-[14px] py-2 text-[13px] font-semibold transition ${
        selected
          ? 'border-[#9D7BC7] bg-[#F3E8FF] text-[#9D7BC7] shadow-sm'
          : 'border-[#E8DCCF] bg-[#F7F3F0] text-[#8A776B] hover:border-[#D9C0A8]'
      }`}
    >
      {label}
    </button>
  );
}
