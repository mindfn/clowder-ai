'use client';

import { type ReactNode, useMemo, useState } from 'react';
import type { EnvVar } from './EnvSubComponents';
import { SettingsSection } from './primitives';

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

function HelpTip({ text }: { text: string }) {
  return (
    <span className="group relative inline-flex items-center">
      <span
        className="flex h-3.5 w-3.5 cursor-help items-center justify-center rounded-full border border-cafe text-[0.5625rem] leading-none text-cafe-muted"
        title={text}
      >
        ?
      </span>
      <span
        className="invisible absolute left-1/2 top-full z-50 mt-1.5 w-max max-w-xs -translate-x-1/2 rounded-md border border-cafe bg-cafe-surface-elevated px-2.5 py-1.5 text-xs text-cafe-secondary opacity-0 shadow-lg transition group-hover:visible group-hover:opacity-100"
        aria-hidden
      >
        {text}
      </span>
    </span>
  );
}

function SettingItem({ variable }: { variable: EnvVar }) {
  const label = variable.label ?? variable.name;
  const displayValue = variable.currentValue ?? variable.defaultValue;

  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-cafe">{label}</span>
          {variable.description && <HelpTip text={variable.description} />}
        </div>
      </div>
      <div className={`text-right ${variable.booleanSemantics ? 'shrink-0' : 'min-w-0 max-w-[50%] overflow-hidden'}`}>
        {variable.booleanSemantics ? (
          <ReadOnlyToggle on={isEffectivelyOn(variable)} label={label} />
        ) : (
          <span className="block truncate font-mono text-sm text-cafe-secondary" title={displayValue}>
            {displayValue}
          </span>
        )}
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
