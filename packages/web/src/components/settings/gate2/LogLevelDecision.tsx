import { useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { SettingsStatusStrip } from '../primitives';
import { DecisionRow, selectClass } from './DecisionRow';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

export function LogLevelDecision() {
  const [logLevel, setLogLevel] = useState<{ stored: string | null; effective: string } | null>(null);
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);

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
    setMessage(null);
    try {
      const res = await apiFetch('/api/config/log-level', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ logLevel: level }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; effectiveLevel?: string };
      if (!res.ok) {
        setMessage({ tone: 'error', text: body.error ?? '保存失败' });
        return;
      }
      setLogLevel({ stored: level, effective: body.effectiveLevel ?? level });
      setMessage({ tone: 'success', text: '已生效' });
    } catch {
      setMessage({ tone: 'error', text: '保存失败' });
    }
  };

  return (
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
        {message && <SettingsStatusStrip tone={message.tone}>{message.text}</SettingsStatusStrip>}
      </div>
    </DecisionRow>
  );
}
