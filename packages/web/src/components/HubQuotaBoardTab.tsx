'use client';

// biome-ignore lint/correctness/noUnusedImports: React must be in scope for SSR JSX runtime in tests.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { apiFetch } from '@/utils/api-client';
import type { AccountsResponse } from './hub-accounts.types';
import { normalizeBuiltinClientIds } from './hub-accounts.view';
import { type AccountQuotaPoolGroup, buildAccountQuotaGroups } from './hub-quota-pools';
import { type CodexUsageItem, QuotaPoolRow, type QuotaResponse, riskDotClass, toUtilization } from './quota-cards';

export const POLL_INTERVAL_MS = 30_000;
export const QUOTA_ALERT_DEDUPE_WINDOW_MS = 30 * 60 * 1000;

// --- Risk logic (kept for notification dedup) ---

interface ConfiguredQuotaPlatforms {
  claude: boolean;
  codex: boolean;
  gemini: boolean;
  kimi: boolean;
  antigravity: boolean;
}

export function resolveConfiguredQuotaPlatforms(
  profiles: AccountsResponse['providers'],
  cats: ReturnType<typeof useCatData>['cats'],
): ConfiguredQuotaPlatforms {
  const clients = new Set(
    normalizeBuiltinClientIds(profiles)
      .filter((profile) => profile.authType === 'oauth')
      .map((profile) => profile.clientId)
      .filter(Boolean),
  );
  return {
    claude: clients.has('anthropic'),
    codex: clients.has('openai'),
    gemini: clients.has('google'),
    kimi: clients.has('kimi'),
    antigravity: cats.some((cat) => cat.clientId === 'antigravity' && cat.roster?.available !== false),
  };
}

function maxUtilization(quota: QuotaResponse | null, configured: ConfiguredQuotaPlatforms): number {
  if (!quota) return 0;
  let max = 0;
  if (configured.codex) for (const item of quota.codex.usageItems) max = Math.max(max, toUtilization(item));
  if (configured.claude) for (const item of quota.claude.usageItems ?? []) max = Math.max(max, toUtilization(item));
  if (configured.gemini) for (const item of quota.gemini?.usageItems ?? []) max = Math.max(max, toUtilization(item));
  if (configured.kimi) for (const item of quota.kimi?.usageItems ?? []) max = Math.max(max, toUtilization(item));
  if (configured.antigravity)
    for (const item of quota.antigravity?.usageItems ?? []) max = Math.max(max, toUtilization(item));
  return max;
}

function resolveRisk(
  quota: QuotaResponse | null,
  refreshError: string | null,
  configured: ConfiguredQuotaPlatforms,
): 'ok' | 'warn' | 'high' {
  if (
    refreshError ||
    (configured.codex && quota?.codex?.error) ||
    (configured.claude && quota?.claude?.error) ||
    (configured.gemini && quota?.gemini?.error) ||
    (configured.kimi && quota?.kimi?.error) ||
    (configured.antigravity && quota?.antigravity?.error)
  )
    return 'high';
  const max = maxUtilization(quota, configured);
  if (max >= 95) return 'high';
  if (max >= 80) return 'warn';
  return 'ok';
}

export function shouldSendQuotaRiskNotification({
  currentRisk,
  previousRisk,
  lastAlertAt,
  nowMs,
  windowMs = QUOTA_ALERT_DEDUPE_WINDOW_MS,
}: {
  currentRisk: 'ok' | 'warn' | 'high';
  previousRisk: 'ok' | 'warn' | 'high';
  lastAlertAt: number;
  nowMs: number;
  windowMs?: number;
}): boolean {
  if (currentRisk !== 'high') return false;
  if (previousRisk !== 'high') return true;
  return nowMs - lastAlertAt >= windowMs;
}

// --- Component ---

export function HubQuotaBoardTab() {
  const { cats } = useCatData();
  const [quota, setQuota] = useState<QuotaResponse | null>(null);
  const [quotaError, setQuotaError] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<AccountsResponse['providers']>([]);
  const [profilesLoaded, setProfilesLoaded] = useState(false);
  const [profilesError, setProfilesError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const previousRiskRef = useRef<'ok' | 'warn' | 'high'>('ok');
  const lastAlertAtRef = useRef<number>(0);

  const configuredPlatforms = resolveConfiguredQuotaPlatforms(profiles, cats);
  const riskLevel = resolveRisk(quota, refreshError, configuredPlatforms);

  const fetchQuota = useCallback(async () => {
    try {
      const res = await apiFetch('/api/quota');
      if (!res.ok) {
        setQuotaError(`配额数据加载失败 (${res.status})，显示的可能是过期数据`);
        return;
      }
      setQuota((await res.json()) as QuotaResponse);
      setQuotaError(null);
    } catch {
      setQuotaError('配额数据加载失败，显示的可能是过期数据');
    }
  }, []);

  useEffect(() => {
    fetchQuota();
    const id = setInterval(fetchQuota, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchQuota]);

  useEffect(() => {
    let cancelled = false;
    setProfilesError(null);
    apiFetch('/api/accounts')
      .then(async (res) => {
        if (!res.ok) {
          if (!cancelled) setProfilesError(`账号配置加载失败 (${res.status})，额度池成员归属可能不完整`);
          return null;
        }
        return (await res.json()) as AccountsResponse;
      })
      .then((body) => {
        if (!cancelled && body) {
          setProfiles(normalizeBuiltinClientIds(body.providers ?? []));
          setProfilesLoaded(true);
          setProfilesError(null);
        }
      })
      .catch(() => {
        if (!cancelled) setProfilesError('账号配置加载失败，额度池成员归属可能不完整');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // System notification on risk transition
  useEffect(() => {
    const prev = previousRiskRef.current;
    const now = Date.now();
    const shouldNotify = shouldSendQuotaRiskNotification({
      currentRisk: riskLevel,
      previousRisk: prev,
      lastAlertAt: lastAlertAtRef.current,
      nowMs: now,
    });
    previousRiskRef.current = riskLevel;
    if (!shouldNotify) return;
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    if (!('serviceWorker' in navigator) || Notification.permission !== 'granted') return;
    void navigator.serviceWorker
      .getRegistration()
      .then((reg) => {
        if (!reg) return;
        lastAlertAtRef.current = now;
        return reg.showNotification('配额高风险预警', {
          body: '有额度池进入高风险，请检查配额看板。',
          tag: 'quota-alert',
        });
      })
      .catch(() => {});
  }, [riskLevel]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    setRefreshError(null);
    try {
      if (!profilesLoaded) {
        setRefreshError(profilesError ?? '账号配置尚未加载，暂不能确定需要刷新的订阅账号');
        return;
      }
      const officialProviders: Array<'claude' | 'codex'> = [];
      if (configuredPlatforms.claude) officialProviders.push('claude');
      if (configuredPlatforms.codex) officialProviders.push('codex');
      const requests: Array<{ fallbackError: string; response: Promise<Response> }> = [];
      if (officialProviders.length > 0) {
        requests.push({
          fallbackError: '获取官方额度失败',
          response: apiFetch('/api/quota/refresh/official', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ interactive: true, providers: officialProviders }),
          }),
        });
      }
      if (configuredPlatforms.claude) {
        requests.push({
          fallbackError: '刷新 Claude 额度失败',
          response: apiFetch('/api/quota/refresh/claude', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          }),
        });
      }
      if (configuredPlatforms.kimi) {
        requests.push({
          fallbackError: '刷新 Kimi 额度失败',
          response: apiFetch('/api/quota/refresh/kimi', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          }),
        });
      }

      const results = await Promise.all(requests.map(async (entry) => ({ ...entry, result: await entry.response })));
      const errors = new Set<string>();
      for (const { result, fallbackError } of results) {
        const body = (await result.json().catch(() => ({}))) as { error?: unknown; warnings?: unknown };
        if (!result.ok) {
          errors.add(typeof body.error === 'string' && body.error.trim() ? body.error : fallbackError);
        }
        if (Array.isArray(body.warnings)) {
          for (const warning of body.warnings) {
            if (typeof warning === 'string' && warning.trim()) errors.add(warning);
          }
        }
      }
      if (errors.size > 0) {
        setRefreshError([...errors].join('；'));
      }
      await fetchQuota();
    } catch {
      setRefreshError('刷新配额失败，请稍后重试');
    } finally {
      setRefreshing(false);
    }
  }, [configuredPlatforms, fetchQuota, profilesError, profilesLoaded]);

  const accountGroups = buildAccountQuotaGroups(quota, profiles, cats);
  const errors = [
    ...new Set(
      [
        quotaError,
        profilesError,
        refreshError,
        configuredPlatforms.codex ? quota?.codex?.error : null,
        configuredPlatforms.claude ? quota?.claude?.error : null,
        configuredPlatforms.gemini ? quota?.gemini?.error : null,
        configuredPlatforms.kimi ? quota?.kimi?.error : null,
        configuredPlatforms.antigravity ? quota?.antigravity?.error : null,
      ]
        .filter(Boolean)
        .flatMap((message) => String(message).split(/；|; (?=[A-Z])/)) as string[],
    ),
  ];

  return (
    <section className="console-list-card space-y-3 rounded-xl p-[18px] shadow-[0_8px_22px_rgba(43,33,26,0.04)]">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-lg font-bold text-cafe">配额看板</h3>
        <div className="flex items-center gap-3">
          {quota?.fetchedAt ? (
            <span className="text-xs text-cafe-muted">{new Date(quota.fetchedAt).toLocaleTimeString()}</span>
          ) : null}
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            className="rounded-full bg-cafe-accent px-3 py-1.5 text-xs font-semibold text-[var(--cafe-surface)] transition hover:bg-cafe-interactive disabled:opacity-50"
          >
            {refreshing ? '刷新中...' : '刷新全部'}
          </button>
        </div>
      </div>

      {errors.length > 0 && (
        <div className="rounded-[16px] border border-conn-red-ring bg-conn-red-bg px-3 py-2 text-xs text-conn-red-text">
          {errors.map((e) => (
            <div key={e}>{e}</div>
          ))}
        </div>
      )}

      {accountGroups.map((group) => (
        <PoolGroupSection key={group.id} group={group} />
      ))}

      <section className="rounded-xl bg-[var(--console-field-bg)] px-4 py-3">
        <p className="text-compact font-bold text-[var(--cafe-accent)]">F127 变化说明</p>
        <p className="mt-1 text-compact leading-6 text-cafe-muted">
          1. 从猫粮看板改名为配额看板
          <br />
          2. 按账号配置维度（非 Provider）分组
          <br />
          3. 每个额度池反向显示关联成员标签
          <br />
          4. 风险阈值提示保留不变
        </p>
      </section>
    </section>
  );
}

function PoolGroupSection({ group }: { group: AccountQuotaPoolGroup }) {
  return (
    <section
      className={`rounded-xl px-4 py-4 ${group.tone === 'success' ? 'bg-conn-emerald-bg' : 'bg-[var(--console-field-bg)]'}`}
    >
      <h4 className="text-lg font-bold text-cafe">{group.title}</h4>
      <p
        className={`mt-1 text-compact leading-6 ${group.tone === 'success' ? 'text-conn-emerald-text' : 'text-cafe-muted'}`}
      >
        {group.description}
      </p>
      <div className="mt-3 space-y-3">
        {group.pools.length > 0 ? (
          group.pools.map((pool) => (
            <PoolSection
              key={pool.id}
              title={pool.title}
              items={pool.items}
              memberTags={pool.memberTags}
              emptyText={pool.emptyText}
            />
          ))
        ) : (
          <div className="rounded-[14px] bg-cafe-surface/80 px-4 py-3 text-xs text-cafe-muted">暂无 API Key 账号</div>
        )}
      </div>
    </section>
  );
}

function PoolSection({
  title,
  items,
  memberTags,
  emptyText,
}: {
  title: string;
  items: CodexUsageItem[];
  memberTags: string[];
  emptyText?: string;
}) {
  // Compute worst utilization for group header dot
  const worstUtil = items.length > 0 ? Math.max(...items.map(toUtilization)) : -1;
  const dotClass = worstUtil >= 0 ? riskDotClass(worstUtil) : 'text-cafe-muted';

  return (
    <div className="console-list-card rounded-xl px-4 py-3 shadow-[0_8px_22px_rgba(43,33,26,0.04)]">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <span className={`text-xs ${dotClass}`} aria-hidden="true">
          {'\u25CF'}
        </span>
        <span className="text-xs font-semibold tracking-wide text-cafe-secondary">{title}</span>
        {memberTags.map((tag) => (
          <span
            key={tag}
            className="rounded-full bg-conn-purple-bg px-2 py-0.5 text-label font-medium text-[var(--color-opus-primary)]"
          >
            {tag}
          </span>
        ))}
      </div>
      {items.length > 0
        ? items.map((item) => <QuotaPoolRow key={item.label} item={item} />)
        : emptyText && <div className="ml-5 text-xs text-cafe-muted">{emptyText}</div>}
    </div>
  );
}
