/**
 * Capability Center UI — F041 统一能力中心组件
 *
 * 卡片式手风琴布局，Pencil MCP 定制 icon
 * - 折叠态：名字 + 描述 + 状态灯 + 全局开关
 * - 展开态：MCP → tools, Skill → triggers, 底部 per-cat 开关（按猫族折叠）
 */

'use client';

import { type ReactNode, useState } from 'react';
import { HubIcon } from './hub-icons';

// ────────── Types ──────────

export interface CapabilityBoardItem {
  id: string;
  type: 'mcp' | 'skill';
  source: 'cat-cafe' | 'external';
  enabled: boolean;
  cats: Record<string, boolean>;
  description?: string;
  triggers?: string[];
  category?: string;
  mounts?: Record<string, boolean>;
  tools?: { name: string; description?: string }[];
  connectionStatus?: 'connected' | 'disconnected' | 'unknown';
}

export interface CatFamily {
  id: string;
  name: string;
  catIds: string[];
}

export interface SkillHealthSummary {
  allMounted: boolean;
  registrationConsistent: boolean;
  unregistered: string[];
  phantom: string[];
}

export interface CapabilityBoardResponse {
  items: CapabilityBoardItem[];
  catFamilies: CatFamily[];
  projectPath: string;
  skillHealth?: SkillHealthSummary;
}

export type ToggleHandler = (
  id: string,
  type: 'mcp' | 'skill',
  enabled: boolean,
  scope?: 'global' | 'cat',
  catId?: string,
) => void;

// ────────── SVG Icons (Pencil MCP design: plug / book-open / puzzle) ──────────

export function McpIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 22v-5" />
      <path d="M9 8V2" />
      <path d="M15 8V2" />
      <path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" />
    </svg>
  );
}

export function SkillIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
      <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
    </svg>
  );
}

export function ExtensionIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M19.439 7.85c-.049.322.059.648.289.878l1.568 1.568c.47.47.706 1.087.706 1.704s-.235 1.233-.706 1.704l-1.611 1.611a.98.98 0 0 1-.837.276c-.47-.07-.802-.48-.968-.925a2.501 2.501 0 1 0-3.214 3.214c.446.166.855.497.925.968a.979.979 0 0 1-.276.837l-1.61 1.61a2.404 2.404 0 0 1-1.705.707 2.402 2.402 0 0 1-1.704-.706l-1.568-1.568a1.026 1.026 0 0 0-.877-.29c-.493.074-.84.504-1.02.968a2.5 2.5 0 1 1-3.237-3.237c.464-.18.894-.527.967-1.02a1.026 1.026 0 0 0-.289-.877l-1.568-1.568A2.402 2.402 0 0 1 1.998 12c0-.617.236-1.234.706-1.704L4.315 8.685a.98.98 0 0 1 .837-.276c.47.07.802.48.968.925a2.501 2.501 0 1 0 3.214-3.214c-.446-.166-.855-.497-.925-.968a.979.979 0 0 1 .276-.837l1.61-1.61a2.404 2.404 0 0 1 1.705-.707c.617 0 1.234.236 1.704.706l1.568 1.568c.23.23.556.338.877.29.493-.074.84-.504 1.02-.969a2.5 2.5 0 1 1 3.237 3.237c-.464.18-.894.527-.967 1.02Z" />
    </svg>
  );
}

// ────────── Section ──────────

export function CapabilitySection({
  icon,
  title,
  subtitle,
  items,
  catFamilies,
  toggling,
  onToggle,
  onDeleteMcp,
  deletingMcp,
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
  items: CapabilityBoardItem[];
  catFamilies: CatFamily[];
  toggling: string | null;
  onToggle: ToggleHandler;
  onDeleteMcp?: (id: string, hard: boolean) => void;
  deletingMcp?: string | null;
}) {
  if (items.length === 0) return null;
  return (
    <div className="mb-6">
      <div className="mb-3 flex items-center gap-3 px-1">
        {icon}
        <div>
          <h3 className="text-[15px] font-semibold tracking-[0.01em] text-cafe">{title}</h3>
          <p className="mt-0.5 text-xs font-medium text-cafe-muted">
            {subtitle} · {items.length}
          </p>
        </div>
      </div>
      <div className="space-y-2.5">
        {items.map((item) => (
          <CapabilityCard
            key={`${item.type}:${item.id}`}
            item={item}
            catFamilies={catFamilies}
            toggling={toggling}
            onToggle={onToggle}
            onDelete={onDeleteMcp && item.type === 'mcp' && item.source === 'external' ? onDeleteMcp : undefined}
            isDeleting={deletingMcp === item.id}
          />
        ))}
      </div>
    </div>
  );
}

// ────────── Accordion Card ──────────

function CapabilityCard({
  item,
  catFamilies,
  toggling,
  onToggle,
  onDelete,
  isDeleting,
}: {
  item: CapabilityBoardItem;
  catFamilies: CatFamily[];
  toggling: string | null;
  onToggle: ToggleHandler;
  onDelete?: (id: string, hard: boolean) => void;
  isDeleting?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const isToggling = toggling === `${item.type}:${item.id}`;
  const hasDetails =
    (item.triggers && item.triggers.length > 0) ||
    (item.tools && item.tools.length > 0) ||
    item.type === 'mcp' ||
    catFamilies.length > 0;

  return (
    <div className="console-list-card rounded-[24px]" data-active={expanded ? 'true' : 'false'}>
      {/* Header */}
      <div className={`flex items-center gap-3 px-4 transition-all duration-300 ${expanded ? 'py-4' : 'py-3.5'}`}>
        <button
          type="button"
          onClick={() => hasDetails && setExpanded((v) => !v)}
          className={`flex-1 min-w-0 flex items-center gap-3 text-left ${hasDetails ? 'cursor-pointer group' : 'cursor-default'}`}
        >
          {hasDetails && (
            <div className="console-pill shrink-0 flex h-8 w-8 items-center justify-center rounded-full text-cafe-secondary transition-colors group-hover:text-cafe">
              <svg
                className={`h-3.5 w-3.5 transition-transform duration-300 ${expanded ? 'rotate-90' : ''}`}
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <path
                  fillRule="evenodd"
                  d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z"
                  clipRule="evenodd"
                />
              </svg>
            </div>
          )}
          {!hasDetails && <span className="w-6 shrink-0" />}

          <div className="flex-1 min-w-0 py-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate text-sm font-semibold text-cafe">{item.id}</span>
              <TypeBadge type={item.type} />
              {item.connectionStatus && <StatusDot status={item.connectionStatus} />}
            </div>
            {item.description && (
              <p className="mt-1 truncate pr-4 text-xs font-medium text-cafe-muted">{item.description}</p>
            )}
          </div>
        </button>

        {/* Global toggle + delete */}
        <div className="flex shrink-0 items-center gap-1.5 pl-2">
          <ToggleSwitch
            enabled={item.enabled}
            disabled={isToggling}
            onChange={(v) => onToggle(item.id, item.type, v)}
          />
          {onDelete && (
            <button
              type="button"
              onClick={() => onDelete(item.id, false)}
              disabled={isDeleting}
              title="禁用此 MCP"
              className="console-button-ghost rounded-full p-2 disabled:opacity-40"
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
                <path
                  fillRule="evenodd"
                  d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z"
                  clipRule="evenodd"
                />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Expanded details */}
      <div
        className={`grid transition-all duration-300 ease-in-out ${
          expanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
        }`}
      >
        <div className="overflow-hidden">
          {expanded && (
            <div className="console-code-pane space-y-4 px-5 py-4 text-xs text-cafe-secondary">
              {/* Full description */}
              {item.description && (
                <div>
                  <span className="console-data-tile-label">描述</span>
                  <p className="mt-1 leading-6 break-words text-cafe-secondary">{item.description}</p>
                </div>
              )}

              {/* MCP tools */}
              {item.type === 'mcp' && item.tools && item.tools.length > 0 && (
                <div>
                  <span className="console-data-tile-label">Tools ({item.tools.length})</span>
                  <ul className="mt-2 space-y-2">
                    {item.tools.map((tool) => (
                      <li key={tool.name} className="console-card-soft rounded-[16px] px-3 py-3">
                        <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:gap-2">
                          <code className="font-mono text-[11px] text-conn-indigo-text">{tool.name}</code>
                          {tool.description && (
                            <span className="leading-6 break-words text-cafe-muted">{tool.description}</span>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {item.type === 'mcp' && (!item.tools || item.tools.length === 0) && (
                <p className="py-1 italic text-cafe-muted">
                  {item.connectionStatus === 'disconnected'
                    ? '探活失败或服务不可达，请检查 MCP 配置'
                    : item.connectionStatus === 'connected'
                      ? '已连接，但该 MCP 服务没有返回 tools'
                      : '当前未探活（或未对任一猫启用）'}
                </p>
              )}

              {/* Skill triggers */}
              {item.type === 'skill' && item.triggers && item.triggers.length > 0 && (
                <div>
                  <span className="console-data-tile-label mb-2 block">触发词</span>
                  <div className="mt-1 flex flex-wrap gap-2">
                    {item.triggers.map((t) => (
                      <span
                        key={t}
                        className="console-pill inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-medium text-conn-indigo-text"
                      >
                        &quot;{t}&quot;
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {item.type === 'skill' && (!item.triggers || item.triggers.length === 0) && (
                <p className="py-1 italic text-cafe-muted">无特定触发词，由上下文自动匹配</p>
              )}

              {/* Skill mount status */}
              {item.type === 'skill' && item.source === 'cat-cafe' && item.mounts && (
                <MountStatusBadges mounts={item.mounts} />
              )}

              {/* Per-cat toggles (grouped by family) */}
              {catFamilies.length > 0 && (
                <CatFamilyToggles item={item} catFamilies={catFamilies} toggling={toggling} onToggle={onToggle} />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ────────── Per-cat toggles grouped by family ──────────

function CatFamilyToggles({
  item,
  catFamilies,
  toggling,
  onToggle,
}: {
  item: CapabilityBoardItem;
  catFamilies: CatFamily[];
  toggling: string | null;
  onToggle: ToggleHandler;
}) {
  const [openFamily, setOpenFamily] = useState<string | null>(null);

  return (
    <div className="border-t border-[color:var(--console-border-soft)] pt-2">
      <span className="text-[11px] font-medium uppercase tracking-wider text-cafe-muted">启用状态（按猫）</span>
      <div className="mt-2 space-y-2">
        {catFamilies.map((family) => {
          const isOpen = openFamily === family.id;
          const relevantCatIds = family.catIds.filter((c) => c in item.cats);
          // For skills: hide families that have no relevant cats to avoid noisy grids.
          if (item.type === 'skill' && relevantCatIds.length === 0) return null;
          const enabledCount = relevantCatIds.filter((c) => item.cats[c]).length;
          return (
            <div key={family.id} className="console-card-soft rounded-[18px]">
              <button
                type="button"
                onClick={() => setOpenFamily(isOpen ? null : family.id)}
                className="flex w-full items-center justify-between px-3 py-2 text-left"
              >
                <span className="text-[12px] font-medium text-cafe">{family.name}</span>
                <span className="text-[11px] text-cafe-muted">
                  {enabledCount}/{relevantCatIds.length}
                  <svg
                    className={`inline-block w-3 h-3 ml-1 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
                    viewBox="0 0 20 20"
                    fill="currentColor"
                  >
                    <path
                      fillRule="evenodd"
                      d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"
                      clipRule="evenodd"
                    />
                  </svg>
                </span>
              </button>
              {isOpen && (
                <div className="space-y-1 px-3 pb-3">
                  {family.catIds.map((catId) => {
                    // Sparse cats: if a skill is not relevant for a cat (provider mismatch),
                    // the backend omits the key entirely. Render a dash instead of a toggle.
                    if (!(catId in item.cats)) {
                      return (
                        <div key={catId} className="flex items-center justify-between py-0.5">
                          <span className="font-mono text-[11px] text-cafe-secondary">{catId}</span>
                          <span className="select-none text-[12px] text-cafe-muted" title="该 Skill 对此猫不适用">
                            –
                          </span>
                        </div>
                      );
                    }
                    const catEnabled = item.cats[catId] ?? false;
                    const isCatToggling = toggling === `${item.type}:${item.id}:${catId}`;
                    return (
                      <div key={catId} className="flex items-center justify-between py-0.5">
                        <span className="font-mono text-[11px] text-cafe-secondary">{catId}</span>
                        <ToggleSwitch
                          enabled={catEnabled}
                          disabled={isCatToggling}
                          size="sm"
                          onChange={(v) => onToggle(item.id, item.type, v, 'cat', catId)}
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ────────── Sub-components ──────────

function TypeBadge({ type }: { type: 'mcp' | 'skill' }) {
  return (
    <span
      className={`inline-flex items-center justify-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
        type === 'mcp'
          ? 'border border-conn-indigo-ring bg-conn-indigo-bg text-conn-indigo-text'
          : 'border border-conn-blue-ring bg-conn-blue-bg text-conn-blue-text'
      }`}
    >
      {type === 'mcp' ? 'MCP' : 'Skill'}
    </span>
  );
}

export function StatusDot({ status }: { status: 'connected' | 'disconnected' | 'unknown' }) {
  const tone = status === 'connected' ? 'active' : status === 'disconnected' ? 'error' : 'info';
  const label = status === 'connected' ? '已连接' : status === 'disconnected' ? '掉线' : '未知';
  return (
    <span className="console-status-chip px-2 py-1 text-[10px]" data-status={tone} title={label}>
      {label}
    </span>
  );
}

function ToggleSwitch({
  enabled,
  disabled,
  size = 'md',
  onChange,
}: {
  enabled: boolean;
  disabled?: boolean;
  size?: 'sm' | 'md';
  onChange: (v: boolean) => void;
}) {
  const isSm = size === 'sm';
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onChange(!enabled);
      }}
      disabled={disabled}
      className={`relative box-content shrink-0 rounded-full border-[3px] border-transparent transition-[background-color,opacity] duration-300 ease-in-out focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-cafe-accent ${
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:opacity-90'
      } ${enabled ? 'bg-cafe-accent' : 'bg-cafe-surface-elevated'} ${isSm ? 'h-3.5 w-7' : 'h-5 w-10'}`}
    >
      <span
        className={`absolute top-0 flex items-center justify-center rounded-full border border-[var(--console-border-soft)] bg-cafe-surface shadow-sm transition-transform duration-300 ease-in-out ${isSm ? 'h-3.5 w-3.5' : 'h-5 w-5'} ${
          enabled ? (isSm ? 'translate-x-[14px]' : 'translate-x-[20px]') : 'translate-x-0'
        }`}
      >
        {enabled && !isSm && (
          <svg className="h-2.5 w-2.5 text-cafe-accent drop-shadow-sm" viewBox="0 0 12 12" fill="none">
            <path
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M3.5 6.5l2 2 3-4"
            />
          </svg>
        )}
      </span>
    </button>
  );
}

/** Mount status badges for cat-cafe skills (provider list is explicit for stable ordering). */
function MountStatusBadges({ mounts }: { mounts: Record<string, boolean> }) {
  const providers = [
    { key: 'claude', label: 'Claude' },
    { key: 'codex', label: 'Codex' },
    { key: 'gemini', label: 'Gemini' },
    { key: 'kimi', label: 'Kimi' },
  ];
  return (
    <div>
      <span className="mb-1.5 block font-medium text-cafe-secondary">挂载状态:</span>
      <div className="flex flex-wrap gap-1.5">
        {providers.map(({ key, label }) => {
          const ok = mounts[key] ?? false;
          return (
            <span
              key={key}
              className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium border ${
                ok
                  ? 'border-conn-emerald-ring bg-conn-emerald-bg text-conn-emerald-text'
                  : 'border-conn-red-ring bg-conn-red-bg text-conn-red-text'
              }`}
            >
              {ok ? (
                <svg className="w-3 h-3" viewBox="0 0 12 12" fill="none">
                  <path
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M3 6.5l2 2 4-4.5"
                  />
                </svg>
              ) : (
                <svg className="w-3 h-3" viewBox="0 0 12 12" fill="none">
                  <path stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" d="M3.5 3.5l5 5M8.5 3.5l-5 5" />
                </svg>
              )}
              {label}
            </span>
          );
        })}
      </div>
    </div>
  );
}

/** Skill health summary banner (allMounted + registrationConsistent) */
export function SkillHealthBanner({ health, items }: { health: SkillHealthSummary; items?: CapabilityBoardItem[] }) {
  const allGood = health.allMounted && health.registrationConsistent;

  // Find skills with mount failures for detail display
  const mountFailures = (items ?? [])
    .filter((i) => i.type === 'skill' && i.source === 'cat-cafe' && i.mounts)
    .filter((i) => !Object.values(i.mounts!).every(Boolean))
    .map((i) => ({
      id: i.id,
      failed: Object.entries(i.mounts!)
        .filter(([, ok]) => !ok)
        .map(([provider]) => provider),
    }));

  return (
    <div
      className={`flex items-start gap-2.5 rounded-[20px] px-4 py-3 text-xs border ${
        allGood
          ? 'border-conn-emerald-ring bg-conn-emerald-bg text-conn-emerald-text'
          : 'border-conn-amber-ring bg-conn-amber-bg text-conn-amber-text'
      }`}
    >
      <HubIcon name={allGood ? 'check' : 'alert-triangle'} className="h-4 w-4 mt-0.5 shrink-0" />
      <div className="space-y-1">
        <div className="flex items-center gap-3">
          <span className={health.allMounted ? 'text-conn-emerald-text' : 'text-conn-amber-text'}>
            {health.allMounted ? '全部正确挂载' : '部分挂载异常'}
          </span>
          <span className="text-cafe-muted/60">·</span>
          <span className={health.registrationConsistent ? 'text-conn-emerald-text' : 'text-conn-amber-text'}>
            {health.registrationConsistent ? '注册一致' : '注册不一致'}
          </span>
        </div>
        {mountFailures.length > 0 && (
          <div className="space-y-0.5 text-conn-amber-text">
            {mountFailures.map((f) => (
              <p key={f.id}>
                <code className="rounded bg-conn-amber-bg px-1 text-[10px]">{f.id}</code> — {f.failed.join(', ')} 未挂载
              </p>
            ))}
          </div>
        )}
        {health.unregistered.length > 0 && (
          <p className="text-conn-amber-text">未注册: {health.unregistered.join(', ')}</p>
        )}
        {health.phantom.length > 0 && <p className="text-conn-amber-text">幽灵项: {health.phantom.join(', ')}</p>}
      </div>
    </div>
  );
}

export function FilterChips({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-xs text-cafe-secondary">{label}:</span>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
            value === opt.value
              ? 'border border-conn-blue-ring bg-conn-blue-bg text-conn-blue-text'
              : 'console-pill text-cafe-secondary hover:text-cafe'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

// ────────── Section Icon Wrappers (Pencil MCP design) ──────────

export function SectionIconMcp() {
  return (
    <div className="flex h-9 w-9 items-center justify-center rounded-[14px] border border-conn-indigo-ring bg-conn-indigo-bg shadow-sm">
      <McpIcon className="h-4 w-4 text-conn-indigo-text" />
    </div>
  );
}

export function SectionIconSkill() {
  return (
    <div className="flex h-9 w-9 items-center justify-center rounded-[14px] border border-conn-amber-ring bg-conn-amber-bg shadow-sm">
      <SkillIcon className="h-4 w-4 text-conn-amber-text" />
    </div>
  );
}

export function SectionIconExtension() {
  return (
    <div className="flex h-9 w-9 items-center justify-center rounded-[14px] border border-conn-emerald-ring bg-conn-emerald-bg shadow-sm">
      <ExtensionIcon className="h-4 w-4 text-conn-emerald-text" />
    </div>
  );
}
