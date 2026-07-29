'use client';

import { useMemo } from 'react';
import {
  type EnvVar,
  initialDraftValue,
  isEditableVariable,
  isMaskedUrlVariable,
  isSensitiveEditable,
} from './EnvSubComponents';
import {
  SettingsBadge,
  SettingsCodeField,
  SettingsPrimaryButton,
  SettingsSection,
  SettingsStatusStrip,
  SettingsText,
} from './primitives';

/* ------------------------------------------------------------------ */
/*  Settings group definitions (display order)                        */
/* ------------------------------------------------------------------ */

const GROUP_ORDER: readonly string[] = ['network', 'storage', 'lifecycle', 'security', 'quota'];

const GROUP_LABELS: Record<string, string> = {
  network: '网络 & 端口',
  storage: '存储',
  lifecycle: '数据生命周期',
  security: '安全 & 访问控制',
  quota: '额度监控',
};

const GROUP_DESCRIPTIONS: Record<string, string> = {
  lifecycle: '设为 0 表示永不过期（推荐）',
};

/* ------------------------------------------------------------------ */
/*  Value display helpers                                             */
/* ------------------------------------------------------------------ */

const BOOLEAN_VARS = new Set([
  'CORS_ALLOW_PRIVATE_NETWORK',
  'MEMORY_STORE',
  'PREVIEW_GATEWAY_ENABLED',
  'PROJECT_ALLOWED_ROOTS_APPEND',
  'QUOTA_OFFICIAL_REFRESH_ENABLED',
]);

function isBooleanDisplay(name: string): boolean {
  return BOOLEAN_VARS.has(name);
}

function isBoolOn(value: string | null): boolean {
  return !!value && value !== '0' && value !== 'false';
}

/** Read-only toggle switch — matches ConfigFieldRenderer toggle style. */
function ReadOnlyToggle({ on, label }: { on: boolean; label: string }) {
  return (
    <div
      role="switch"
      tabIndex={-1}
      aria-checked={on}
      aria-label={label}
      aria-disabled
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors cursor-default ${
        on ? 'bg-conn-emerald-text' : 'bg-cafe-surface-sunken'
      }`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 rounded-full bg-cafe-white transition-transform ${
          on ? 'translate-x-4' : 'translate-x-0.5'
        }`}
      />
    </div>
  );
}

function isTtlVar(name: string): boolean {
  return name.endsWith('_TTL_SECONDS');
}

/* ------------------------------------------------------------------ */
/*  Single setting row — Codex-style inline layout                    */
/* ------------------------------------------------------------------ */

interface SettingItemProps {
  v: EnvVar;
  draft: string;
  onDraftChange: (name: string, value: string) => void;
}

function EditableControl({ v, draft, onDraftChange }: SettingItemProps) {
  const inputType = isSensitiveEditable(v) ? 'password' : isTtlVar(v.name) ? 'number' : 'text';
  const placeholder = isSensitiveEditable(v)
    ? v.currentValue
      ? '已设置'
      : '输入密钥'
    : isMaskedUrlVariable(v)
      ? '已脱敏'
      : v.defaultValue;
  return (
    <SettingsCodeField
      aria-label={v.name}
      type={inputType}
      autoComplete={isSensitiveEditable(v) ? 'off' : undefined}
      className="!w-48 text-right"
      value={draft}
      onChange={(e) => onDraftChange(v.name, e.target.value)}
      placeholder={placeholder}
    />
  );
}

function ReadOnlyControl({ v, label }: { v: EnvVar; label: string }) {
  if (isBooleanDisplay(v.name)) {
    return <ReadOnlyToggle on={isBoolOn(v.currentValue)} label={label} />;
  }
  return (
    <SettingsText tone="secondary" variant="sm" className="font-mono">
      {v.currentValue ?? v.defaultValue}
    </SettingsText>
  );
}

function SettingItem({ v, draft, onDraftChange }: SettingItemProps) {
  const editable = isEditableVariable(v);
  const label = v.label ?? v.name;
  const needsRestart = v.runtimeEditable === false || v.restartRequired === true;

  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-cafe">{label}</span>
          {editable && needsRestart && (
            <SettingsBadge tone="amber" size="xxs">
              需重启
            </SettingsBadge>
          )}
        </div>
        <SettingsText as="p" tone="muted" variant="xs" className="mt-0.5">
          {v.description}
        </SettingsText>
      </div>
      <div className="shrink-0 text-right">
        {editable ? (
          <EditableControl v={v} draft={draft} onDraftChange={onDraftChange} />
        ) : (
          <ReadOnlyControl v={v} label={label} />
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main component — replaces EnvVarsSection for surface='system'     */
/* ------------------------------------------------------------------ */

interface SystemSettingsViewProps {
  variables: EnvVar[];
  drafts: Record<string, string>;
  isDirty: boolean;
  saveState: { saving: boolean; error: string | null; success: string | null };
  onDraftChange: (name: string, value: string) => void;
  onSave: () => void;
}

export function SystemSettingsView({
  variables,
  drafts,
  isDirty,
  saveState,
  onDraftChange,
  onSave,
}: SystemSettingsViewProps) {
  const groups = useMemo(() => {
    const map = new Map<string, EnvVar[]>();
    for (const v of variables) {
      const key = v.settingsGroup ?? 'other';
      const arr = map.get(key) ?? [];
      arr.push(v);
      map.set(key, arr);
    }
    // Return in display order, then any ungrouped
    const ordered: Array<{ key: string; label: string; description?: string; vars: EnvVar[] }> = [];
    for (const key of GROUP_ORDER) {
      const vars = map.get(key);
      if (vars?.length) {
        ordered.push({ key, label: GROUP_LABELS[key] ?? key, description: GROUP_DESCRIPTIONS[key], vars });
        map.delete(key);
      }
    }
    // Remaining groups (should not happen if registry is complete)
    for (const [key, vars] of map) {
      ordered.push({ key, label: GROUP_LABELS[key] ?? key, vars });
    }
    return ordered;
  }, [variables]);

  const pendingRestartCount = variables.filter(
    (v) =>
      (v.runtimeEditable === false || v.restartRequired === true) &&
      drafts[v.name] !== undefined &&
      drafts[v.name] !== initialDraftValue(v),
  ).length;

  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <SettingsSection key={group.key} title={group.label} description={group.description}>
          <div className="divide-y divide-[var(--console-border-soft)]">
            {group.vars.map((v) => (
              <SettingItem key={v.name} v={v} draft={drafts[v.name] ?? ''} onDraftChange={onDraftChange} />
            ))}
          </div>
        </SettingsSection>
      ))}

      {pendingRestartCount > 0 && (
        <SettingsStatusStrip tone="warn">{pendingRestartCount} 项变更需要重启生效</SettingsStatusStrip>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <SettingsPrimaryButton onClick={onSave} disabled={!isDirty || saveState.saving}>
          {saveState.saving ? '保存中...' : '保存到 .env'}
        </SettingsPrimaryButton>
        {saveState.error && <SettingsStatusStrip tone="error">{saveState.error}</SettingsStatusStrip>}
        {saveState.success && <SettingsStatusStrip tone="success">{saveState.success}</SettingsStatusStrip>}
      </div>
    </div>
  );
}
