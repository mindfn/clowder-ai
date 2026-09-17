'use client';

// F770 Gate 2: the system settings page rebuilt on the user coordinate system
// (docs/plans/770-settings-product-gate.md). Six read-only status facts plus
// five decisions, replacing the env-var dump (former SystemSettingsView):
//
//   ① 数据存放位置  — .env write (PATCH /api/config/env), restart required
//   ② 允许局域网访问 — one toggle writing API_SERVER_HOST + CORS_ALLOW_PRIVATE_NETWORK
//                     together (index.ts:6129 warns when host is 0.0.0.0 without
//                     the CORS flag — the pair must never drift apart), restart
//   ③ 数据保留      — PUT /api/config/retention, immediate
//   ④ 日志详细程度  — PUT /api/config/log-level, immediate
//   ⑤ 禁止访问目录  — PUT /api/config/denied-roots, immediate
//
// Copy rule (四·七): label + control + (only when true)（重启生效）; at most one
// line of small print under a label, and that line states the current fact —
// no explanatory paragraphs, no env var names, no advice.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { DirPickerField } from './DirPickerField';
import type { EnvVar } from './EnvSubComponents';
import { HubFileLink } from './EnvSubComponents';
import { SettingsPrimaryButton, SettingsSection, SettingsStatusStrip } from './primitives';

const RETENTION_CATEGORIES = [
  { key: 'message', label: '消息' },
  { key: 'thread', label: '话题' },
  { key: 'task', label: '任务' },
  { key: 'summary', label: '摘要' },
  { key: 'backlog', label: '待办' },
] as const;

type RetentionKey = (typeof RETENTION_CATEGORIES)[number]['key'];
type RetentionConfig = Record<RetentionKey, number>;

const DAY_SECONDS = 86400;

// 6 个月 / 3 个月 / 1 个月 map to 180 / 90 / 30 days — fixed-length presets so
// the dropdown value always round-trips exactly (a calendar-month duration is
// not representable as a constant second count).
const RETENTION_PRESETS = [
  { key: 'forever', label: '永不过期', days: 0 },
  { key: '6mo', label: '6 个月', days: 180 },
  { key: '3mo', label: '3 个月', days: 90 },
  { key: '1mo', label: '1 个月', days: 30 },
  { key: 'week', label: '本周', days: 7 },
] as const;

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

function isAbsolutePath(value: string): boolean {
  return /^(\/|[A-Za-z]:[\\/])/.test(value);
}

/** Same switch markup as the retired dump view — visual continuity. */
function ToggleSwitch({ on, onToggle, ariaLabel }: { on: boolean; onToggle: () => void; ariaLabel: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={ariaLabel}
      onClick={onToggle}
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

function StatusRow({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="text-sm font-medium text-cafe">{label}</div>
      <div
        className={`min-w-0 max-w-[60%] truncate text-right text-sm text-cafe-muted ${mono ? 'font-mono' : ''}`}
        title={value}
      >
        {value}
      </div>
    </div>
  );
}

function DecisionRow({
  label,
  restart,
  smallPrint,
  children,
}: {
  label: string;
  restart?: boolean;
  smallPrint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-cafe">
          {label}
          {restart && <span className="ml-1 text-xs font-normal text-cafe-muted">（重启生效）</span>}
        </div>
        {smallPrint && <div className="mt-0.5 text-xs text-cafe-muted leading-5">{smallPrint}</div>}
      </div>
      <div className="min-w-0 max-w-[50%] flex-1">{children}</div>
    </div>
  );
}

const selectClass =
  'h-9 w-full rounded-lg border border-transparent bg-[var(--console-field-bg)] px-3 text-compact text-cafe';

async function patchEnv(updates: Array<{ name: string; value: string }>): Promise<string | null> {
  try {
    const res = await apiFetch('/api/config/env', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updates }),
    });
    if (res.ok) return null;
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return body.error ?? '保存失败';
  } catch {
    return '保存失败';
  }
}

export function SystemSettingsGate2({ variables }: { variables: EnvVar[] }) {
  // Local overrides for .env vars this page just wrote. env-summary is fetched
  // once by the parent and intentionally NOT refetched after a save (#770 P0
  // D7: a refetch returns the stale pre-restart currentValue and bounces the
  // UI) — so the just-written value lives here until the next real reload.
  const [envOverrides, setEnvOverrides] = useState<Record<string, string>>({});
  const effectiveEnvValue = useCallback(
    (envVarEntry: EnvVar | undefined) =>
      envVarEntry ? (envOverrides[envVarEntry.name] ?? envVarEntry.currentValue ?? '') : '',
    [envOverrides],
  );

  const byName = useMemo(() => new Map(variables.map((variable) => [variable.name, variable])), [variables]);

  // ── Status facts ──────────────────────────────────────────────────────────
  const redisUrl = byName.get('REDIS_URL')?.currentValue?.trim() ?? '';
  const memoryMode = redisUrl.length === 0;
  const dataDir = byName.get('DATA_DIR')?.currentValue?.trim() || '(未设置 — 使用默认位置)';
  const apiHost = byName.get('API_SERVER_HOST')?.currentValue?.trim() || '127.0.0.1';
  const apiPort = byName.get('API_SERVER_PORT')?.currentValue?.trim() || '';
  const ownerAnchor = byName.get('DEFAULT_OWNER_USER_ID')?.currentValue?.trim() ?? '';
  const platformDir = byName.get('CAT_CAFE_DATA_DIR')?.currentValue?.trim() || '(平台默认)';

  const pendingItems = useMemo(
    () =>
      variables
        .filter((variable) => variable.restartRequired)
        .map((variable) => ({
          label: variable.label ?? variable.name,
          saved: envOverrides[variable.name] ?? variable.savedValue ?? null,
          current: variable.currentValue,
        }))
        .filter(
          (item) => item.saved != null && item.saved !== '' && item.current != null && item.saved !== item.current,
        ),
    [variables, envOverrides],
  );

  // ── ① 数据存放位置 ─────────────────────────────────────────────────────────
  const dataDirVariable = byName.get('DATA_DIR');
  const dataDirEffective = effectiveEnvValue(dataDirVariable);
  const [dataDirDraft, setDataDirDraft] = useState(dataDirEffective);
  const [dataDirMessage, setDataDirMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  // Draft initialized once at mount (same D7 rationale as the retired view).
  const [dirDraftInitialized, setDirDraftInitialized] = useState(false);
  useEffect(() => {
    if (!dirDraftInitialized && dataDirVariable) {
      setDataDirDraft(effectiveEnvValue(dataDirVariable));
      setDirDraftInitialized(true);
    }
  }, [dirDraftInitialized, dataDirVariable, effectiveEnvValue]);

  const saveDataDir = async () => {
    setDataDirMessage(null);
    const error = await patchEnv([{ name: 'DATA_DIR', value: dataDirDraft.trim() }]);
    if (error) {
      setDataDirMessage({ tone: 'error', text: error });
      return;
    }
    setEnvOverrides((prev) => ({ ...prev, DATA_DIR: dataDirDraft.trim() }));
    setDataDirMessage({ tone: 'success', text: '已保存，重启后生效' });
  };

  // ── ② 允许局域网访问 ────────────────────────────────────────────────────────
  const lanOn =
    effectiveEnvValue(byName.get('API_SERVER_HOST')) === '0.0.0.0' &&
    effectiveEnvValue(byName.get('CORS_ALLOW_PRIVATE_NETWORK')) === 'true';
  const [lanMessage, setLanMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);

  const toggleLan = async () => {
    setLanMessage(null);
    const updates = lanOn
      ? [
          { name: 'API_SERVER_HOST', value: '127.0.0.1' },
          { name: 'CORS_ALLOW_PRIVATE_NETWORK', value: 'false' },
        ]
      : [
          { name: 'API_SERVER_HOST', value: '0.0.0.0' },
          { name: 'CORS_ALLOW_PRIVATE_NETWORK', value: 'true' },
        ];
    const error = await patchEnv(updates);
    if (error) {
      setLanMessage({ tone: 'error', text: error });
      return;
    }
    setEnvOverrides((prev) => ({ ...prev, ...Object.fromEntries(updates.map((u) => [u.name, u.value])) }));
    setLanMessage({ tone: 'success', text: '已保存，重启后生效' });
  };

  // ── ③ 数据保留 ────────────────────────────────────────────────────────────
  const [retention, setRetention] = useState<{ config: RetentionConfig; draftTtlSeconds: number } | null>(null);
  const [retentionChoice, setRetentionChoice] = useState<string>('forever');
  const [retentionCustomDays, setRetentionCustomDays] = useState<Record<RetentionKey, string> | null>(null);
  const [retentionMessage, setRetentionMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/config/retention')
      .then(async (response) => {
        if (!response.ok) return;
        const body = (await response.json()) as { config: RetentionConfig; draftTtlSeconds: number };
        if (cancelled) return;
        setRetention({ config: body.config, draftTtlSeconds: body.draftTtlSeconds });
        const values = RETENTION_CATEGORIES.map((category) => body.config[category.key]);
        const uniform = values.every((value) => value === values[0]) ? values[0] : null;
        const preset =
          uniform != null ? RETENTION_PRESETS.find((entry) => entry.days * DAY_SECONDS === uniform) : undefined;
        if (preset) {
          setRetentionChoice(preset.key);
        } else {
          setRetentionChoice('custom');
          setRetentionCustomDays(
            Object.fromEntries(
              RETENTION_CATEGORIES.map((category) => [
                category.key,
                body.config[category.key] > 0 ? String(Math.round(body.config[category.key] / DAY_SECONDS)) : '',
              ]),
            ) as Record<RetentionKey, string>,
          );
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const putRetention = async (config: RetentionConfig) => {
    setRetentionMessage(null);
    try {
      const res = await apiFetch('/api/config/retention', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; config?: RetentionConfig };
      if (!res.ok) {
        setRetentionMessage({ tone: 'error', text: body.error ?? '保存失败' });
        return;
      }
      if (body.config) setRetention((prev) => (prev ? { ...prev, config: body.config! } : prev));
      setRetentionMessage({ tone: 'success', text: '已生效' });
    } catch {
      setRetentionMessage({ tone: 'error', text: '保存失败' });
    }
  };

  const handleRetentionChoice = (choice: string) => {
    setRetentionChoice(choice);
    setRetentionMessage(null);
    if (choice === 'custom') {
      setRetentionCustomDays(
        (prev) =>
          prev ??
          (retention
            ? (Object.fromEntries(
                RETENTION_CATEGORIES.map((category) => [
                  category.key,
                  retention.config[category.key] > 0
                    ? String(Math.round(retention.config[category.key] / DAY_SECONDS))
                    : '',
                ]),
              ) as Record<RetentionKey, string>)
            : ({ message: '', thread: '', task: '', summary: '', backlog: '' } as Record<RetentionKey, string>)),
      );
      return;
    }
    const preset = RETENTION_PRESETS.find((entry) => entry.key === choice);
    if (!preset) return;
    const seconds = preset.days * DAY_SECONDS;
    void putRetention({ message: seconds, thread: seconds, task: seconds, summary: seconds, backlog: seconds });
  };

  const saveCustomRetention = async () => {
    if (!retentionCustomDays) return;
    const config = Object.fromEntries(
      RETENTION_CATEGORIES.map((category) => {
        const days = Number.parseInt(retentionCustomDays[category.key], 10);
        return [category.key, Number.isFinite(days) && days > 0 ? days * DAY_SECONDS : 0];
      }),
    ) as unknown as RetentionConfig;
    await putRetention(config);
  };

  // ── ④ 日志详细程度 ─────────────────────────────────────────────────────────
  const [logLevel, setLogLevel] = useState<{ stored: string | null; effective: string } | null>(null);
  const [logLevelMessage, setLogLevelMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/config/log-level')
      .then(async (response) => {
        if (!response.ok) return;
        const body = (await response.json()) as { logLevel: string | null; effectiveLevel: string };
        if (!cancelled) setLogLevel({ stored: body.logLevel, effective: body.effectiveLevel });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const saveLogLevel = async (level: string) => {
    setLogLevelMessage(null);
    try {
      const res = await apiFetch('/api/config/log-level', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ logLevel: level }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; effectiveLevel?: string };
      if (!res.ok) {
        setLogLevelMessage({ tone: 'error', text: body.error ?? '保存失败' });
        return;
      }
      setLogLevel({ stored: level, effective: body.effectiveLevel ?? level });
      setLogLevelMessage({ tone: 'success', text: '已生效' });
    } catch {
      setLogLevelMessage({ tone: 'error', text: '保存失败' });
    }
  };

  // ── ⑤ 禁止访问目录 ─────────────────────────────────────────────────────────
  const [deniedRoots, setDeniedRoots] = useState<string[] | null>(null);
  const [deniedInput, setDeniedInput] = useState('');
  const [deniedMessage, setDeniedMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);

  const loadDeniedRoots = useCallback(() => {
    apiFetch('/api/config/denied-roots')
      .then(async (response) => {
        if (!response.ok) return;
        const body = (await response.json()) as { deniedRoots: string[] };
        setDeniedRoots(body.deniedRoots);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    loadDeniedRoots();
  }, [loadDeniedRoots]);

  const putDeniedRoots = async (roots: string[]) => {
    setDeniedMessage(null);
    try {
      const res = await apiFetch('/api/config/denied-roots', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deniedRoots: roots }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; deniedRoots?: string[] };
      if (!res.ok) {
        setDeniedMessage({ tone: 'error', text: body.error ?? '保存失败' });
        return false;
      }
      setDeniedRoots(body.deniedRoots ?? roots);
      return true;
    } catch {
      setDeniedMessage({ tone: 'error', text: '保存失败' });
      return false;
    }
  };

  const addDeniedRoot = async () => {
    const trimmed = deniedInput.trim();
    if (!trimmed) return;
    if (!isAbsolutePath(trimmed)) {
      setDeniedMessage({ tone: 'error', text: '需要绝对路径（以 / 开头）' });
      return;
    }
    if ((deniedRoots ?? []).includes(trimmed)) {
      setDeniedInput('');
      return;
    }
    if (await putDeniedRoots([...(deniedRoots ?? []), trimmed])) setDeniedInput('');
  };

  const removeDeniedRoot = async (root: string) => {
    await putDeniedRoots((deniedRoots ?? []).filter((entry) => entry !== root));
  };

  const retentionSmallPrint = retention
    ? `只对新数据生效，已有数据不会被清理；草稿保存 ${Math.round(retention.draftTtlSeconds / 60)} 分钟后自动清除`
    : '只对新数据生效，已有数据不会被清理';

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <HubFileLink relPath=".env" label="打开 .env ↗" />
      </div>

      <SettingsSection title="系统状态">
        <div className="divide-y divide-[var(--console-border-soft)]">
          <StatusRow label="存储模式" value={memoryMode ? '内存模式' : '持久化（Redis）'} mono={false} />
          <StatusRow label="数据存在哪" value={dataDir} />
          <StatusRow label="当前访问地址与端口" value={apiPort ? `http://${apiHost}:${apiPort}` : apiHost} />
          <StatusRow
            label="所有者模式"
            value={ownerAnchor ? `已设锚点（${ownerAnchor}）` : '单用户本地'}
            mono={false}
          />
          <StatusRow label="平台状态目录" value={platformDir} />
        </div>
        {memoryMode && <SettingsStatusStrip tone="warn">内存模式下，重启后数据不会保留</SettingsStatusStrip>}
        {pendingItems.length > 0 && (
          <div className="mt-2 space-y-1">
            {pendingItems.map((item) => (
              <div key={item.label} className="text-xs text-cafe-muted">
                待重启 · {item.label}：已保存 {item.saved}，当前生效 {item.current}
              </div>
            ))}
          </div>
        )}
      </SettingsSection>

      <SettingsSection title="常用设置">
        <div className="divide-y divide-[var(--console-border-soft)]">
          <DecisionRow label="数据存放位置" restart>
            <div className="flex items-center gap-2">
              <DirPickerField
                value={dataDirDraft}
                onChange={setDataDirDraft}
                placeholder="默认位置"
                aria-label="数据存放位置"
              />
              <SettingsPrimaryButton
                onClick={() => void saveDataDir()}
                disabled={!dirDraftInitialized || dataDirDraft.trim() === dataDirEffective.trim()}
              >
                保存
              </SettingsPrimaryButton>
            </div>
            {dataDirMessage && (
              <div className="mt-1">
                <SettingsStatusStrip tone={dataDirMessage.tone}>{dataDirMessage.text}</SettingsStatusStrip>
              </div>
            )}
          </DecisionRow>

          <DecisionRow
            label="允许局域网访问"
            restart
            smallPrint={lanOn ? '可被同一局域网中的任意设备访问' : '仅本地可以访问'}
          >
            <div className="flex justify-end">
              <ToggleSwitch on={lanOn} onToggle={() => void toggleLan()} ariaLabel="允许局域网访问" />
            </div>
            {lanMessage && (
              <div className="mt-1">
                <SettingsStatusStrip tone={lanMessage.tone}>{lanMessage.text}</SettingsStatusStrip>
              </div>
            )}
          </DecisionRow>

          <DecisionRow label="数据保留" smallPrint={retentionSmallPrint}>
            <div className="space-y-2">
              <select
                aria-label="数据保留"
                value={retentionChoice}
                onChange={(event) => handleRetentionChoice(event.target.value)}
                className={selectClass}
              >
                {RETENTION_PRESETS.map((preset) => (
                  <option key={preset.key} value={preset.key}>
                    {preset.label}
                  </option>
                ))}
                <option value="custom">自定义…</option>
              </select>
              {retentionChoice === 'custom' && retentionCustomDays && (
                <div className="space-y-2">
                  <div className="grid grid-cols-2 gap-2">
                    {RETENTION_CATEGORIES.map((category) => (
                      <label key={category.key} className="flex items-center gap-2 text-xs text-cafe-muted">
                        <span className="w-8 shrink-0">{category.label}</span>
                        <input
                          type="number"
                          min={0}
                          aria-label={`${category.label}保留天数`}
                          value={retentionCustomDays[category.key]}
                          placeholder="永久"
                          onChange={(event) =>
                            setRetentionCustomDays((prev) =>
                              prev ? { ...prev, [category.key]: event.target.value } : prev,
                            )
                          }
                          className="h-8 w-full min-w-0 rounded-lg border border-transparent bg-[var(--console-field-bg)] px-2 text-compact text-cafe"
                        />
                        <span className="shrink-0">天</span>
                      </label>
                    ))}
                  </div>
                  <SettingsPrimaryButton onClick={() => void saveCustomRetention()}>保存</SettingsPrimaryButton>
                </div>
              )}
              {retentionMessage && (
                <SettingsStatusStrip tone={retentionMessage.tone}>{retentionMessage.text}</SettingsStatusStrip>
              )}
            </div>
          </DecisionRow>

          <DecisionRow label="日志详细程度">
            <div className="space-y-2">
              <select
                aria-label="日志详细程度"
                value={logLevel?.stored ?? logLevel?.effective ?? 'info'}
                onChange={(event) => void saveLogLevel(event.target.value)}
                className={selectClass}
              >
                {LOG_LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </select>
              {logLevelMessage && (
                <SettingsStatusStrip tone={logLevelMessage.tone}>{logLevelMessage.text}</SettingsStatusStrip>
              )}
            </div>
          </DecisionRow>

          <DecisionRow label="禁止访问目录" smallPrint="平台默认的系统目录始终会被拦截">
            <div className="space-y-2">
              {(deniedRoots ?? []).map((root) => (
                <div key={root} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-cafe" title={root}>
                    {root}
                  </span>
                  <button
                    type="button"
                    aria-label={`移除 ${root}`}
                    onClick={() => void removeDeniedRoot(root)}
                    className="shrink-0 rounded px-1.5 text-xs text-cafe-muted hover:text-cafe"
                  >
                    ✕
                  </button>
                </div>
              ))}
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  aria-label="添加禁止访问目录"
                  value={deniedInput}
                  placeholder="绝对路径，如 /private/tmp"
                  onChange={(event) => setDeniedInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void addDeniedRoot();
                  }}
                  className="h-8 w-full min-w-0 rounded-lg border border-transparent bg-[var(--console-field-bg)] px-2 font-mono text-xs text-cafe"
                />
                <SettingsPrimaryButton onClick={() => void addDeniedRoot()} disabled={!deniedInput.trim()}>
                  添加
                </SettingsPrimaryButton>
              </div>
              {deniedMessage && (
                <SettingsStatusStrip tone={deniedMessage.tone}>{deniedMessage.text}</SettingsStatusStrip>
              )}
            </div>
          </DecisionRow>
        </div>
      </SettingsSection>
    </div>
  );
}
