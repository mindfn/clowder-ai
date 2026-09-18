import { useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { SettingsPrimaryButton, SettingsStatusStrip } from '../primitives';
import { DecisionRow, selectClass } from './DecisionRow';

const MINUTE_MS = 60_000;

// Human-unit presets. 0 = disabled (manual cancel only), matching
// DEFAULT_CLI_TIMEOUT_MS in packages/api/src/utils/cli-timeout.ts; the
// preset values round-trip exactly in minutes.
const TIMEOUT_PRESETS = [
  { key: 'never', label: '永不超时（仅人工取消）', minutes: 0 },
  { key: '1m', label: '1 分钟', minutes: 1 },
  { key: '5m', label: '5 分钟', minutes: 5 },
  { key: '10m', label: '10 分钟', minutes: 10 },
  { key: '30m', label: '30 分钟', minutes: 30 },
  { key: '60m', label: '1 小时', minutes: 60 },
] as const;

export function CliTimeoutDecision() {
  const [effectiveMs, setEffectiveMs] = useState<number | null>(null);
  const [choice, setChoice] = useState<string>('never');
  const [customMinutes, setCustomMinutes] = useState('');
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/config')
      .then(async (response) => {
        if (!response.ok) return;
        const body = (await response.json()) as { config?: { cli?: { timeoutMs?: number } } };
        if (cancelled) return;
        const timeoutMs = body.config?.cli?.timeoutMs ?? 0;
        setEffectiveMs(timeoutMs);
        const preset = TIMEOUT_PRESETS.find((entry) => entry.minutes * MINUTE_MS === timeoutMs);
        if (preset) {
          setChoice(preset.key);
        } else {
          setChoice('custom');
          setCustomMinutes(String(Math.round(timeoutMs / MINUTE_MS)));
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async (minutes: number) => {
    setMessage(null);
    try {
      const res = await apiFetch('/api/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'cli.timeoutMs', value: minutes * MINUTE_MS }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setMessage({ tone: 'error', text: body.error ?? '保存失败' });
        return;
      }
      setEffectiveMs(minutes * MINUTE_MS);
      setMessage({ tone: 'success', text: '已生效' });
    } catch {
      setMessage({ tone: 'error', text: '保存失败' });
    }
  };

  const handleChoice = (next: string) => {
    setChoice(next);
    setMessage(null);
    if (next === 'custom') {
      if (customMinutes === '' && effectiveMs != null) {
        setCustomMinutes(String(Math.round(effectiveMs / MINUTE_MS)));
      }
      return;
    }
    const preset = TIMEOUT_PRESETS.find((entry) => entry.key === next);
    if (preset) void save(preset.minutes);
  };

  const saveCustom = async () => {
    const minutes = Number.parseInt(customMinutes, 10);
    if (!Number.isFinite(minutes) || minutes < 0) return;
    await save(minutes);
  };

  return (
    <DecisionRow label="调用超时" smallPrint="立即生效，新发起的调用使用新值；超时计时期间命令行有输出会自动重置">
      <div className="space-y-2">
        <select
          aria-label="调用超时"
          value={choice}
          onChange={(event) => handleChoice(event.target.value)}
          className={selectClass}
        >
          {TIMEOUT_PRESETS.map((preset) => (
            <option key={preset.key} value={preset.key}>
              {preset.label}
            </option>
          ))}
          <option value="custom">自定义…</option>
        </select>
        {choice === 'custom' && (
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={0}
              aria-label="自定义超时分钟"
              value={customMinutes}
              placeholder="分钟"
              onChange={(event) => setCustomMinutes(event.target.value)}
              className="h-8 w-full min-w-0 rounded-lg border border-transparent bg-[var(--console-field-bg)] px-2 text-compact text-cafe"
            />
            <span className="shrink-0 text-xs text-cafe-muted">分钟</span>
            <SettingsPrimaryButton onClick={() => void saveCustom()}>保存</SettingsPrimaryButton>
          </div>
        )}
        {message && <SettingsStatusStrip tone={message.tone}>{message.text}</SettingsStatusStrip>}
      </div>
    </DecisionRow>
  );
}
