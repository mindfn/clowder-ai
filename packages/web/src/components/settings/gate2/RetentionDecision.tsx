import { useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { SettingsPrimaryButton, SettingsStatusStrip } from '../primitives';
import { DecisionRow, selectClass } from './DecisionRow';

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

export function RetentionDecision() {
  const [retention, setRetention] = useState<{ config: RetentionConfig; draftTtlSeconds: number } | null>(null);
  const [retentionChoice, setRetentionChoice] = useState<string>('forever');
  const [retentionCustomDays, setRetentionCustomDays] = useState<Record<RetentionKey, string> | null>(null);
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);

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
    setMessage(null);
    try {
      const res = await apiFetch('/api/config/retention', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; config?: RetentionConfig };
      if (!res.ok) {
        setMessage({ tone: 'error', text: body.error ?? '保存失败' });
        return;
      }
      if (body.config) setRetention((prev) => (prev ? { ...prev, config: body.config! } : prev));
      setMessage({ tone: 'success', text: '已生效' });
    } catch {
      setMessage({ tone: 'error', text: '保存失败' });
    }
  };

  const handleRetentionChoice = (choice: string) => {
    setRetentionChoice(choice);
    setMessage(null);
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

  const smallPrint = retention
    ? `只对新数据生效，已有数据不会被清理；草稿保存 ${Math.round(retention.draftTtlSeconds / 60)} 分钟后自动清除`
    : '只对新数据生效，已有数据不会被清理';

  return (
    <DecisionRow label="数据保留" smallPrint={smallPrint}>
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
                      setRetentionCustomDays((prev) => (prev ? { ...prev, [category.key]: event.target.value } : prev))
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
        {message && <SettingsStatusStrip tone={message.tone}>{message.text}</SettingsStatusStrip>}
      </div>
    </DecisionRow>
  );
}
