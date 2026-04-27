import type { DragEvent as ReactDragEvent } from 'react';
import type { CatData } from '@/hooks/useCatData';
import type { CatConfig, CoCreatorConfig } from './config-viewer-types';

function safeAvatarSrc(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('/uploads/') || trimmed.startsWith('/avatars/')) return trimmed;
  return null;
}

function humanizeClientId(clientId: string) {
  if (clientId === 'openai') return 'OpenAI';
  if (clientId === 'anthropic') return 'Anthropic';
  if (clientId === 'google') return 'Gemini';
  if (clientId === 'dare') return 'Dare';
  if (clientId === 'opencode') return 'OpenCode';
  if (clientId === 'antigravity') return 'Antigravity';
  return clientId;
}

function clientRuntimeLabel(cat: CatData, configCat?: CatConfig) {
  const accountRef = (cat.accountRef ?? '').toLowerCase();
  if (accountRef.includes('claude')) return 'Claude';
  if (accountRef.includes('codex')) return 'Codex';
  if (accountRef.includes('gemini')) return 'Gemini';
  if (accountRef.includes('kimi') || accountRef.includes('moonshot')) return 'Kimi';
  if (accountRef.includes('opencode')) return 'OpenCode';
  if (accountRef.includes('dare')) return 'Dare';
  if (cat.clientId === 'antigravity') return 'Antigravity';
  if (cat.clientId === 'openai') return 'OpenAI-Compatible';
  return humanizeClientId(configCat?.clientId ?? cat.clientId);
}

function accountSummary(cat: CatData) {
  const accountRef = cat.accountRef?.trim() ?? '';
  if (!accountRef) return humanizeClientId(cat.clientId);
  if (
    accountRef === 'claude' ||
    accountRef === 'codex' ||
    accountRef === 'gemini' ||
    accountRef === 'kimi' ||
    accountRef === 'dare' ||
    accountRef === 'opencode'
  ) {
    return 'CLI（OAuth）账号';
  }
  return `CLI（配置） · ${accountRef}`;
}

function getMetaSummary(cat: CatData, configCat?: CatConfig) {
  if (cat.clientId === 'antigravity') {
    return `Antigravity · ${configCat?.model ?? cat.defaultModel} · CLI Bridge`;
  }

  return `${clientRuntimeLabel(cat, configCat)} · ${configCat?.model ?? cat.defaultModel} · ${accountSummary(cat)}`;
}

function getStatusBadge(cat: CatData) {
  if (cat.roster?.available === false) {
    return {
      enabled: false,
      label: '未启用',
      className: 'bg-slate-100 text-slate-600',
    };
  }
  return {
    enabled: true,
    label: '已启用',
    className: 'bg-[#E8F5E9] text-[#4CAF50]',
  };
}

function getSessionChainBadge(cat: CatData) {
  const enabled = cat.sessionChain !== false;
  return {
    label: enabled ? 'Session Chain 已开启' : 'Session Chain 未开启',
    className: enabled ? 'bg-[#E8F5E9] text-[#4CAF50]' : 'bg-slate-100 text-slate-600',
  };
}

function formatMentionPreview(patterns: string[], max = 3) {
  const visible = patterns.slice(0, max);
  const rest = patterns.length - visible.length;
  return rest > 0 ? `${visible.join('  ')}  +${rest}` : visible.join('  ');
}

export function HubCoCreatorOverviewCard({ coCreator, onEdit }: { coCreator: CoCreatorConfig; onEdit?: () => void }) {
  const primary = coCreator.color?.primary ?? '#D4A76A';
  const avatarSrc = safeAvatarSrc(coCreator.avatar);

  return (
    <section
      role={onEdit ? 'button' : undefined}
      tabIndex={onEdit ? 0 : undefined}
      onClick={() => onEdit?.()}
      onKeyDown={(event) => {
        if (!onEdit) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onEdit();
        }
      }}
      className="flex h-24 cursor-pointer items-center gap-4 rounded-2xl bg-[var(--console-card-bg)] px-5 py-[18px] shadow-[0_8px_24px_rgba(43,33,26,0.05)] transition hover:shadow-[0_8px_24px_rgba(43,33,26,0.09)]"
    >
      <div
        className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full text-[11px] font-bold text-white"
        style={{ backgroundColor: primary }}
      >
        {avatarSrc ? (
          // biome-ignore lint/performance/noImgElement: co-creator avatar may be runtime upload URL
          // eslint-disable-next-line @next/next/no-img-element
          <img src={avatarSrc} alt={`${coCreator.name} avatar`} className="h-full w-full object-cover" />
        ) : (
          'ME'
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-bold text-cafe">{coCreator.name}</p>
        <p className="mt-1 text-[12px] text-cafe-secondary truncate">别名: {coCreator.aliases.join(' · ') || '无'}</p>
      </div>
      <span className="shrink-0 rounded-md bg-[#F3E1D6] px-2 py-1 text-[11px] font-semibold text-[#6F3A2C]">Owner</span>
      <span className="shrink-0 text-[12px] font-bold text-[#6F3A2C]">预览 / 编辑 →</span>
    </section>
  );
}

export function HubOverviewToolbar({ onAddMember }: { onAddMember?: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cafe-muted">Roster</p>
      </div>
      <button
        type="button"
        onClick={onAddMember}
        className="flex items-center gap-2 rounded-lg bg-[var(--cafe-accent)] px-3.5 py-2 text-[13px] font-semibold text-[var(--cafe-accent-foreground)] transition-colors hover:opacity-80"
        data-bootcamp-step="add-member-button"
        data-guide-id="cats.add-member"
      >
        + 添加成员
      </button>
    </div>
  );
}

export function HubMemberOverviewCard({
  cat,
  configCat,
  onEdit,
  onToggleAvailability,
  onDelete,
  togglingAvailability = false,
  draggable = false,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  isDragging = false,
  guideTargetId,
}: {
  cat: CatData;
  configCat?: CatConfig;
  onEdit?: (cat: CatData) => void;
  onToggleAvailability?: (cat: CatData) => void;
  onDelete?: (cat: CatData) => void;
  togglingAvailability?: boolean;
  draggable?: boolean;
  onDragStart?: (cat: CatData, event: ReactDragEvent<HTMLElement>) => void;
  onDragOver?: (cat: CatData, event: ReactDragEvent<HTMLElement>) => void;
  onDrop?: (cat: CatData, event: ReactDragEvent<HTMLElement>) => void;
  onDragEnd?: (cat: CatData, event: ReactDragEvent<HTMLElement>) => void;
  isDragging?: boolean;
  guideTargetId?: string;
}) {
  const status = getStatusBadge(cat);
  const sessionChain = getSessionChainBadge(cat);
  const title = [cat.breedDisplayName ?? cat.displayName, cat.nickname].filter(Boolean).join(' · ');
  const editCard = () => onEdit?.(cat);

  return (
    <section
      data-testid={`cat-card-${cat.id}`}
      draggable={draggable || undefined}
      onDragStart={draggable ? (event) => onDragStart?.(cat, event) : undefined}
      onDragOver={draggable ? (event) => onDragOver?.(cat, event) : undefined}
      onDrop={draggable ? (event) => onDrop?.(cat, event) : undefined}
      onDragEnd={draggable ? (event) => onDragEnd?.(cat, event) : undefined}
      onClick={editCard}
      className={`flex h-24 cursor-pointer items-center gap-4 rounded-2xl bg-[var(--console-card-bg)] px-5 py-[18px] shadow-[0_8px_24px_rgba(43,33,26,0.05)] transition hover:shadow-[0_8px_24px_rgba(43,33,26,0.09)] ${isDragging ? 'opacity-40' : ''}`}
      data-guide-id={guideTargetId}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          {draggable ? (
            <span
              aria-hidden="true"
              title="拖动排序"
              className="mt-1 cursor-grab select-none text-[18px] leading-none text-cafe-muted"
            >
              ⠿
            </span>
          ) : null}
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              editCard();
            }}
            data-guide-id={guideTargetId}
            className="min-w-0 flex-1 cursor-pointer text-left"
          >
            <h3 className="text-[17px] font-bold text-cafe">{title}</h3>
            <p className="mt-2.5 text-[13px] text-cafe-secondary">
              {getMetaSummary(cat, configCat)}
              {cat.adapterMode ? (
                <span
                  className={`ml-1.5 inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                    cat.adapterMode === 'acp' ? 'bg-[#E8F5E9] text-[#4CAF50]' : 'bg-slate-100 text-slate-500'
                  }`}
                >
                  {cat.adapterMode.toUpperCase()}
                </span>
              ) : null}
            </p>

            <div className="mt-2 flex flex-wrap items-center gap-2">
              <p className="text-[13px] text-[#9D7BC7]">{formatMentionPreview(cat.mentionPatterns)}</p>
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${sessionChain.className}`}>
                {sessionChain.label}
              </span>
            </div>
          </button>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onToggleAvailability?.(cat);
            }}
            disabled={!onToggleAvailability || togglingAvailability}
            aria-pressed={status.enabled}
            className={`rounded-full px-2.5 py-1 text-[11px] font-semibold transition ${status.className} disabled:cursor-default`}
          >
            {togglingAvailability ? '切换中...' : status.label}
          </button>
          {onDelete ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onDelete(cat);
              }}
              className="rounded-full bg-conn-red-bg p-1.5 text-conn-red-text transition hover:opacity-80"
              aria-label="删除成员"
            >
              <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 fill-none stroke-current" aria-hidden="true">
                <path
                  d="M3.5 4.5h9m-7.5 0V3.25h5V4.5m-5.5 0 .5 8h5l.5-8m-4 2v4m2-4v4"
                  strokeWidth="1.25"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}
