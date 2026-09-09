'use client';

import { type ReactNode, useMemo, useState } from 'react';
import { DirPickerField } from './DirPickerField';
import type { EnvVar } from './EnvSubComponents';
import { SettingsCodeField, SettingsSection } from './primitives';

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

function ReadOnlyToggle({ on, label }: { on: boolean; label: string }) {
  return (
    <span
      role="img"
      aria-label={`${label}: ${on ? '开启' : '关闭'}`}
      className={`relative inline-flex h-5 w-9 items-center rounded-full ${
        on ? 'bg-conn-emerald-text' : 'bg-cafe-surface-sunken'
      }`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 rounded-full bg-cafe-white transition-transform ${
          on ? 'translate-x-4' : 'translate-x-0.5'
        }`}
      />
    </span>
  );
}

function resolveControlType(variable: EnvVar): 'text' | 'toggle' | 'dropdown' | 'dirpicker' {
  return (
    variable.control ?? (variable.booleanSemantics ? 'toggle' : variable.allowedValues?.length ? 'dropdown' : 'text')
  );
}

/** 展示性控件：本视图全部只读、无保存通道，控件一律 disabled/readOnly，仅用于
 *  以控件形态传达当前值（对齐 Codex 设置页行样式）。 */
function SettingControl({ variable }: { variable: EnvVar }) {
  const control = resolveControlType(variable);
  const value = variable.currentValue ?? variable.defaultValue;
  const label = variable.label ?? variable.name;

  switch (control) {
    case 'toggle':
      return <ReadOnlyToggle on={isEffectivelyOn(variable)} label={label} />;
    case 'dropdown':
      return (
        <select
          disabled
          aria-label={label}
          value={value}
          className="h-9 rounded-lg border border-transparent bg-[var(--console-field-bg)] px-3 text-compact text-cafe-muted"
        >
          {(variable.allowedValues ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      );
    case 'dirpicker':
      return <DirPickerField value={value} disabled aria-label={label} />;
    default:
      return <SettingsCodeField readOnly aria-label={label} value={value} />;
  }
}

function SettingItem({ variable }: { variable: EnvVar }) {
  const label = variable.label ?? variable.name;
  const control = resolveControlType(variable);

  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-cafe">{label}</div>
        {variable.description && <div className="mt-0.5 text-xs text-cafe-muted leading-5">{variable.description}</div>}
      </div>
      <div className={control === 'toggle' ? 'shrink-0' : 'min-w-0 max-w-[50%] flex-1'}>
        <SettingControl variable={variable} />
      </div>
    </div>
  );
}

interface SystemSettingsViewProps {
  variables: EnvVar[];
  groupLabels: Record<string, string>;
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

export function SystemSettingsView({ variables, groupLabels }: SystemSettingsViewProps) {
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

  return (
    <div className="space-y-4">
      {runtimeGroups.map((group) => (
        <SettingsSection key={group.key} title={group.label} description={group.description}>
          <div className="divide-y divide-[var(--console-border-soft)]">
            {group.variables.map((variable) => (
              <SettingItem key={variable.name} variable={variable} />
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
                  <SettingItem key={variable.name} variable={variable} />
                ))}
              </div>
            </div>
          ))}
        </CollapsibleAdvancedSection>
      )}
    </div>
  );
}
