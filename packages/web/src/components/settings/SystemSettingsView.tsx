'use client';

import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { DirPickerField } from './DirPickerField';
import type { EnvVar } from './EnvSubComponents';
import { HubFileLink, initialDraftValue, isEditableVariable, isMaskedUrlVariable } from './EnvSubComponents';
import { SettingsCodeField, SettingsPrimaryButton, SettingsSection, SettingsStatusStrip } from './primitives';

const GROUP_ORDER: readonly string[] = ['network', 'storage', 'lifecycle', 'runtime', 'security'];

const GROUP_DESCRIPTIONS: Record<string, string> = {
  lifecycle: '各类数据的自动清理时间。设为 0 表示永久保留（推荐）',
};

function isEffectivelyOn(variable: EnvVar): boolean {
  const semantics = variable.booleanSemantics;
  if (!semantics) return false;
  if (variable.currentValue == null) return semantics.defaultOn;

  const raw = variable.currentValue;
  switch (semantics.trueWhen ?? 'parseBoolEnv') {
    case 'exactTrue':
      return raw === 'true';
    case 'exactOne':
      return raw === '1';
    case 'notZero':
      return raw !== '0';
    default:
      return raw === '1' || raw.toLowerCase() === 'true';
  }
}

function resolveControlType(variable: EnvVar): 'text' | 'number' | 'toggle' | 'dropdown' | 'dirpicker' {
  return (
    variable.control ?? (variable.booleanSemantics ? 'toggle' : variable.allowedValues?.length ? 'dropdown' : 'text')
  );
}

/** 可编辑分支：draft 驱动；toggle 写回 '1'/'0'。 */
function EditableSettingControl({
  variable,
  draft,
  onDraftChange,
}: {
  variable: EnvVar;
  draft: string;
  onDraftChange: (name: string, value: string) => void;
}) {
  const control = resolveControlType(variable);
  const label = variable.label ?? variable.name;

  switch (control) {
    case 'toggle': {
      const on = isEffectivelyOn({ ...variable, currentValue: draft || null });
      return (
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={label}
          onClick={() => onDraftChange(variable.name, on ? '0' : '1')}
          className={`relative inline-flex h-5 w-9 items-center rounded-full ${
            on ? 'bg-conn-emerald-text' : 'bg-cafe-surface-sunken'
          }`}
        >
          <span
            className={`inline-block h-3.5 w-3.5 rounded-full bg-cafe-white transition-transform ${
              on ? 'translate-x-4' : 'translate-x-0.5'
            }`}
          />
        </button>
      );
    }
    case 'dropdown': {
      const options = variable.allowedValues ?? [];
      return (
        <select
          aria-label={label}
          value={draft}
          onChange={(e) => onDraftChange(variable.name, e.target.value)}
          className="h-9 w-full rounded-lg border border-transparent bg-[var(--console-field-bg)] px-3 text-compact text-cafe"
        >
          {options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
          {draft && !options.includes(draft) && <option value={draft}>{draft}（当前值）</option>}
        </select>
      );
    }
    case 'dirpicker':
      return (
        <DirPickerField
          value={draft}
          onChange={(path) => onDraftChange(variable.name, path)}
          placeholder={variable.placeholder ?? variable.defaultValue}
          aria-label={label}
        />
      );
    case 'number':
      return (
        <SettingsCodeField
          type="number"
          aria-label={label}
          value={draft}
          placeholder={variable.placeholder ?? (variable.defaultValue || undefined)}
          onChange={(e) => onDraftChange(variable.name, e.target.value)}
        />
      );
    default:
      return (
        <SettingsCodeField
          aria-label={label}
          value={draft}
          placeholder={variable.placeholder ?? (variable.defaultValue || undefined)}
          onChange={(e) => onDraftChange(variable.name, e.target.value)}
        />
      );
  }
}

function SettingItem({
  variable,
  draft,
  onDraftChange,
}: {
  variable: EnvVar;
  draft: string | undefined;
  onDraftChange: (name: string, value: string) => void;
}) {
  const label = variable.label ?? variable.name;
  const control = resolveControlType(variable);
  const editable = isEditableVariable(variable);

  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-cafe">{label}</div>
        {variable.description && <div className="mt-0.5 text-xs text-cafe-muted leading-5">{variable.description}</div>}
      </div>
      <div className={control === 'toggle' ? 'shrink-0' : 'min-w-0 max-w-[50%] flex-1'}>
        {editable ? (
          <EditableSettingControl variable={variable} draft={draft ?? ''} onDraftChange={onDraftChange} />
        ) : (
          <span className="block truncate font-mono text-sm text-cafe-muted" title={variable.currentValue ?? undefined}>
            {variable.currentValue ?? '未设置'}
          </span>
        )}
      </div>
    </div>
  );
}

interface SystemSettingsViewProps {
  variables: EnvVar[];
  groupLabels: Record<string, string>;
  onSaved?: () => void;
}

function groupVariablesByGroup(variables: EnvVar[], groupLabels: Record<string, string>) {
  const grouped = new Map<string, EnvVar[]>();
  for (const variable of variables) {
    const key = variable.settingsGroup ?? 'other';
    grouped.set(key, [...(grouped.get(key) ?? []), variable]);
  }

  const ordered: Array<{ key: string; label: string; description?: string; variables: EnvVar[] }> = [];
  for (const key of GROUP_ORDER) {
    const entries = grouped.get(key);
    if (!entries?.length) continue;
    ordered.push({ key, label: groupLabels[key] ?? key, description: GROUP_DESCRIPTIONS[key], variables: entries });
    grouped.delete(key);
  }
  for (const [key, entries] of grouped) {
    ordered.push({ key, label: groupLabels[key] ?? key, variables: entries });
  }
  return ordered;
}

function CollapsibleAdvancedSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <SettingsSection title={title} description={description}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full items-center justify-between rounded-md px-1 py-2 text-sm font-medium text-cafe-secondary hover:bg-cafe-surface-sunken/50 transition-colors"
      >
        <span>{open ? '收起高级信息' : '展开高级信息（端口、路径、TTL 等）'}</span>
        <span className="text-cafe-muted">{open ? '▲' : '▼'}</span>
      </button>
      {open && <div className="mt-2">{children}</div>}
    </SettingsSection>
  );
}

export function SystemSettingsView({ variables, groupLabels, onSaved }: SystemSettingsViewProps) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saveState, setSaveState] = useState<{ saving: boolean; error: string | null; success: string | null }>({
    saving: false,
    error: null,
    success: null,
  });

  // (Re)initialize drafts whenever the fetched variables change (mount + post-save refetch).
  useEffect(() => {
    setDrafts(
      Object.fromEntries(
        variables.filter(isEditableVariable).map((variable) => [variable.name, initialDraftValue(variable)]),
      ),
    );
  }, [variables]);

  const { runtimeVars, restartVars } = useMemo(() => {
    const runtime: EnvVar[] = [];
    const restart: EnvVar[] = [];
    for (const variable of variables) {
      if (variable.restartRequired) {
        restart.push(variable);
      } else {
        runtime.push(variable);
      }
    }
    return { runtimeVars: runtime, restartVars: restart };
  }, [variables]);

  const runtimeGroups = useMemo(() => groupVariablesByGroup(runtimeVars, groupLabels), [runtimeVars, groupLabels]);
  const restartGroups = useMemo(() => groupVariablesByGroup(restartVars, groupLabels), [restartVars, groupLabels]);

  const editableVariables = useMemo(() => variables.filter(isEditableVariable), [variables]);
  const changedUpdates = editableVariables
    .map((variable) => ({
      name: variable.name,
      value: drafts[variable.name] ?? '',
      baselineValue: initialDraftValue(variable),
      maskedUrl: isMaskedUrlVariable(variable),
      restartRequired: variable.restartRequired === true,
    }))
    .filter((variable) => variable.value !== variable.baselineValue)
    .filter((variable) => !variable.maskedUrl || variable.value.trim().length > 0);
  const isDirty = changedUpdates.length > 0;
  const pendingRestartCount = changedUpdates.filter((variable) => variable.restartRequired).length;

  const handleDraftChange = (name: string, value: string) => {
    setDrafts((prev) => ({ ...prev, [name]: value }));
    setSaveState((prev) => ({ ...prev, error: null, success: null }));
  };

  const handleSave = async () => {
    if (!isDirty || saveState.saving) return;
    setSaveState({ saving: true, error: null, success: null });
    try {
      const res = await apiFetch('/api/config/env', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates: changedUpdates.map(({ name, value }) => ({ name, value })) }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setSaveState({ saving: false, error: body.error ?? '保存失败', success: null });
        return;
      }
      setSaveState({ saving: false, error: null, success: '已写回 .env，重启后生效' });
      onSaved?.();
    } catch {
      setSaveState({ saving: false, error: '保存失败', success: null });
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <HubFileLink relPath=".env" label="打开 .env ↗" />
      </div>
      {runtimeGroups.map((group) => (
        <SettingsSection key={group.key} title={group.label} description={group.description}>
          <div className="divide-y divide-[var(--console-border-soft)]">
            {group.variables.map((variable) => (
              <SettingItem
                key={variable.name}
                variable={variable}
                draft={drafts[variable.name]}
                onDraftChange={handleDraftChange}
              />
            ))}
          </div>
        </SettingsSection>
      ))}

      {restartGroups.length > 0 && (
        <CollapsibleAdvancedSection title="系统信息（高级）" description="以下配置修改后需要重启服务才能生效">
          {restartGroups.map((group) => (
            <div key={group.key} className="mb-4 last:mb-0">
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-cafe-muted">{group.label}</h4>
              <div className="divide-y divide-[var(--console-border-soft)] rounded-md border border-[var(--console-border-soft)]">
                {group.variables.map((variable) => (
                  <SettingItem
                    key={variable.name}
                    variable={variable}
                    draft={drafts[variable.name]}
                    onDraftChange={handleDraftChange}
                  />
                ))}
              </div>
            </div>
          ))}
        </CollapsibleAdvancedSection>
      )}

      {editableVariables.length > 0 && (
        <div className="space-y-2">
          {pendingRestartCount > 0 && (
            <SettingsStatusStrip tone="warn">{pendingRestartCount} 项变更需重启生效</SettingsStatusStrip>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <SettingsPrimaryButton onClick={handleSave} disabled={!isDirty || saveState.saving}>
              {saveState.saving ? '保存中...' : '保存到 .env'}
            </SettingsPrimaryButton>
            {saveState.error && <SettingsStatusStrip tone="error">{saveState.error}</SettingsStatusStrip>}
            {saveState.success && <SettingsStatusStrip tone="success">{saveState.success}</SettingsStatusStrip>}
          </div>
        </div>
      )}
    </div>
  );
}
