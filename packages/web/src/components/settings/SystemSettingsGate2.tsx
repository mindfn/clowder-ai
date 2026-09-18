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
//   ⑥ 调用超时      — PATCH /api/config (ConfigStore cli.timeoutMs, writes
//                     through process.env so per-invocation readers see it at
//                     once), immediate
//
// Copy rule (四·七): label + control + (only when true)（重启生效）; at most one
// line of small print under a label, and that line states the current fact —
// no explanatory paragraphs, no env var names, no advice.
//
// Status rows answer in absolute resolved paths (API `resolvedValue`), never in
// env coordinates — 「数据存在哪」must not degrade to 「（未设置）」.

import { useEffect, useMemo, useState } from 'react';
import type { EnvVar } from './EnvSubComponents';
import { HubFileLink } from './EnvSubComponents';
import { CliTimeoutDecision } from './gate2/CliTimeoutDecision';
import { DataLocationDecision } from './gate2/DataLocationDecision';
import { type DecisionMessage } from './gate2/DecisionRow';
import { DeniedRootsDecision } from './gate2/DeniedRootsDecision';
import { patchEnv, useEnvOverrides } from './gate2/env-overrides';
import { LanAccessDecision } from './gate2/LanAccessDecision';
import { LogLevelDecision } from './gate2/LogLevelDecision';
import { RetentionDecision } from './gate2/RetentionDecision';
import { StatusSection } from './gate2/StatusSection';
import { SettingsSection } from './primitives';

export function SystemSettingsGate2({ variables }: { variables: EnvVar[] }) {
  const { envOverrides, setEnvOverrides, effectiveEnvValue } = useEnvOverrides();
  const byName = useMemo(() => new Map(variables.map((variable) => [variable.name, variable])), [variables]);

  // ── Status facts ──────────────────────────────────────────────────────────
  const redisUrl = byName.get('REDIS_URL')?.currentValue?.trim() ?? '';
  const memoryMode = redisUrl.length === 0;
  const dataDirEntry = byName.get('DATA_DIR');
  const dataDirDisplay =
    dataDirEntry?.resolvedValue ?? (memoryMode ? '内存（重启后丢失）' : dataDirEntry?.currentValue?.trim() || '');
  const apiHost = byName.get('API_SERVER_HOST')?.currentValue?.trim() || '127.0.0.1';
  const frontendPort = byName.get('FRONTEND_PORT')?.currentValue?.trim() || '';
  // The address the user is actually looking at — the API port (3006-class)
  // is not where a human opens the page. 0.0.0.0 is a bind address, not a
  // connectable one, so the composed fallback maps it back to loopback.
  const connectableHost = apiHost === '0.0.0.0' ? '127.0.0.1' : apiHost;
  const accessAddress =
    typeof window !== 'undefined' && window.location.origin.startsWith('http')
      ? window.location.origin
      : `http://${connectableHost}${frontendPort ? `:${frontendPort}` : ''}`;
  const ownerAnchor = byName.get('DEFAULT_OWNER_USER_ID')?.currentValue?.trim() ?? '';
  const catCafeEntry = byName.get('CAT_CAFE_DATA_DIR');
  const platformDir = catCafeEntry?.resolvedValue ?? catCafeEntry?.currentValue?.trim() ?? '';

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
  const [dataDirMessage, setDataDirMessage] = useState<DecisionMessage | null>(null);
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
  const [lanMessage, setLanMessage] = useState<DecisionMessage | null>(null);

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

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <HubFileLink relPath=".env" label="打开 .env ↗" />
      </div>

      <StatusSection
        memoryMode={memoryMode}
        dataDirDisplay={dataDirDisplay}
        accessAddress={accessAddress}
        ownerLabel={ownerAnchor ? `已设锚点（${ownerAnchor}）` : '单用户本地'}
        platformDir={platformDir}
        pendingItems={pendingItems}
      />

      <SettingsSection title="常用设置">
        <div className="divide-y divide-[var(--console-border-soft)]">
          <DataLocationDecision
            draft={dataDirDraft}
            effective={dataDirEffective}
            initialized={dirDraftInitialized}
            message={dataDirMessage}
            onDraftChange={setDataDirDraft}
            onSave={() => void saveDataDir()}
          />
          <LanAccessDecision on={lanOn} message={lanMessage} onToggle={() => void toggleLan()} />
          <RetentionDecision />
          <LogLevelDecision />
          <DeniedRootsDecision />
          <CliTimeoutDecision />
        </div>
      </SettingsSection>
    </div>
  );
}
