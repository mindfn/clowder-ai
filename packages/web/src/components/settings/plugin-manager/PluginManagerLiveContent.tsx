'use client';

import type {
  PluginManagerContributionToolsResponse,
  PluginManagerDetail,
  PluginManagerDetailResponse,
  PluginManagerDocumentationResponse,
  PluginManagerListItem,
  PluginManagerListResponse,
} from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useConfirm } from '@/components/useConfirm';
import { apiFetch } from '@/utils/api-client';
import { PluginManagerContent } from './PluginManagerContent';
import type { PluginManagerDesignFixture } from './plugin-manager-fixtures';

const POLL_INTERVAL_MS = 5_000;

type ConsolePluginManagerDetail = PluginManagerDetail & {
  readonly readmeMarkdown?: string;
  readonly readmeUnavailable?: boolean;
  readonly tools?: PluginManagerContributionToolsResponse['tools'];
};

type DocumentationFetchResult =
  | { readonly state: 'available'; readonly readmeMarkdown: string }
  | { readonly state: 'absent' }
  | { readonly state: 'unavailable' };

function packageName(plugin: PluginManagerListItem): string {
  return plugin.source.packageName ?? plugin.pluginId;
}

function fixtureDetail(detail: ConsolePluginManagerDetail | undefined): Partial<PluginManagerDesignFixture> {
  if (!detail) return {};
  return {
    ...(detail.contributions === undefined
      ? {}
      : { contributions: detail.contributions.map((contribution) => ({ ...contribution })) }),
    ...(detail.tools === undefined
      ? {}
      : {
          tools: detail.tools.map(({ contributionId, name, description }) => ({
            contributionId,
            name,
            ...(description === undefined ? {} : { description }),
          })),
        }),
    ...(detail.readmeMarkdown === undefined ? {} : { readmeMarkdown: detail.readmeMarkdown }),
    ...(detail.readmeUnavailable === true ? { readmeUnavailable: true } : {}),
    ...(detail.setupSteps === undefined ? {} : { setupSteps: detail.setupSteps }),
    ...(detail.docsUrl === undefined ? {} : { docsUrl: detail.docsUrl }),
    ...(detail.configFields === undefined ? {} : { configFields: detail.configFields }),
  };
}

function designFixture(
  plugin: PluginManagerListItem,
  detail: ConsolePluginManagerDetail | undefined,
): PluginManagerDesignFixture {
  const capabilities = detail?.capabilities ?? plugin.capabilitySummary;
  return {
    id: plugin.pluginId,
    displayName: plugin.displayName,
    description: plugin.description ?? plugin.displayName,
    icon: plugin.icon ?? 'blocks',
    ...(plugin.iconBg === undefined ? {} : { iconBg: plugin.iconBg }),
    publisher: plugin.publisher ?? (plugin.source.trust === 'official' ? 'Clowder AI' : 'Local Host'),
    packageName: packageName(plugin),
    source: plugin.source.kind === 'catalog' ? 'catalog' : 'local',
    trust: plugin.source.trust === 'official' ? 'official' : 'local-trusted',
    ...(plugin.source.kind === 'compatibility' ? { sourceAdapter: plugin.source.adapter } : {}),
    availableVersion: plugin.availableVersion ?? plugin.installedVersion ?? 'unknown',
    installedVersion: plugin.installedVersion,
    artifact: plugin.artifact,
    config: plugin.config,
    auth: plugin.auth,
    intent: plugin.intent,
    live: plugin.live,
    capabilities: capabilities.map((capability) => ({
      name: capability.name,
      description:
        'description' in capability && typeof capability.description === 'string'
          ? capability.description
          : capability.name,
    })),
    ...fixtureDetail(detail),
    ...(plugin.diagnostic === undefined ? {} : { diagnostic: plugin.diagnostic.message }),
    actions: plugin.actions,
  };
}

async function responseError(response: Response, fallback: string): Promise<{ message: string; code?: string }> {
  const body = (await response.json().catch(() => ({}))) as { error?: unknown; code?: unknown };
  return {
    message: typeof body.error === 'string' && body.error.length > 0 ? body.error : fallback,
    ...(typeof body.code === 'string' ? { code: body.code } : {}),
  };
}

function isListResponse(value: unknown): value is PluginManagerListResponse {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { plugins?: unknown; catalog?: { status?: unknown } };
  return Array.isArray(candidate.plugins) && typeof candidate.catalog?.status === 'string';
}

function isDetailResponse(value: unknown): value is PluginManagerDetailResponse {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { plugin?: { pluginId?: unknown }; catalog?: { status?: unknown } };
  return typeof candidate.plugin?.pluginId === 'string' && typeof candidate.catalog?.status === 'string';
}

function isDocumentationResponse(value: unknown): value is PluginManagerDocumentationResponse {
  if (!value || typeof value !== 'object') return false;
  const readmeMarkdown = (value as { readmeMarkdown?: unknown }).readmeMarkdown;
  return readmeMarkdown === undefined || typeof readmeMarkdown === 'string';
}

function isContributionToolsResponse(value: unknown): value is PluginManagerContributionToolsResponse {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { pluginId?: unknown; tools?: unknown };
  return (
    typeof candidate.pluginId === 'string' &&
    Array.isArray(candidate.tools) &&
    candidate.tools.every(
      (tool) =>
        tool !== null &&
        typeof tool === 'object' &&
        typeof (tool as { contributionId?: unknown }).contributionId === 'string' &&
        typeof (tool as { name?: unknown }).name === 'string',
    )
  );
}

async function fetchDocumentation(path: string): Promise<DocumentationFetchResult> {
  const response = await apiFetch(`${path}/documentation`).catch(() => undefined);
  if (response === undefined) return { state: 'unavailable' };
  if (response.status === 404) return { state: 'absent' };
  if (!response.ok) return { state: 'unavailable' };
  const value: unknown = await response.json().catch(() => undefined);
  if (!isDocumentationResponse(value)) return { state: 'unavailable' };
  return value.readmeMarkdown === undefined
    ? { state: 'absent' }
    : { state: 'available', readmeMarkdown: value.readmeMarkdown };
}

async function fetchContributionTools(
  path: string,
): Promise<PluginManagerContributionToolsResponse['tools'] | undefined> {
  const response = await apiFetch(`${path}/contributions/tools`).catch(() => undefined);
  if (!response?.ok) return undefined;
  const value: unknown = await response.json().catch(() => undefined);
  return isContributionToolsResponse(value) ? value.tools : undefined;
}

async function fetchManagerDetail(pluginId: string, afterMutation: boolean): Promise<ConsolePluginManagerDetail> {
  const path = `/api/plugin-manager/plugins/${encodeURIComponent(pluginId)}`;
  const [response, documentation] = await Promise.all([
    afterMutation ? apiFetch(path, undefined, { afterCurrentGet: true }) : apiFetch(path),
    fetchDocumentation(path),
  ]);
  if (!response.ok) throw new Error(`detail request failed (${response.status})`);
  const value: unknown = await response.json();
  if (!isDetailResponse(value)) throw new Error('detail response is invalid');
  const tools =
    value.plugin.artifact === 'installed' && value.plugin.live === 'running' ? await fetchContributionTools(path) : [];
  return {
    ...value.plugin,
    ...(documentation.state === 'available' ? { readmeMarkdown: documentation.readmeMarkdown } : {}),
    ...(documentation.state === 'unavailable' ? { readmeUnavailable: true } : {}),
    ...(tools === undefined ? {} : { tools }),
  };
}

async function fetchManagerList(search: string, afterMutation: boolean): Promise<PluginManagerListResponse> {
  const normalized = search.trim();
  const path =
    normalized.length === 0
      ? '/api/plugin-manager/plugins'
      : `/api/plugin-manager/plugins/search?q=${encodeURIComponent(normalized)}`;
  const response = afterMutation ? await apiFetch(path, undefined, { afterCurrentGet: true }) : await apiFetch(path);
  if (!response.ok) throw new Error(`list request failed (${response.status})`);
  const value: unknown = await response.json();
  if (!isListResponse(value)) throw new Error('list response is invalid');
  return value;
}

function selectedPluginId(plugins: readonly PluginManagerListItem[], current: string | null): string | null {
  return plugins.some((plugin) => plugin.pluginId === current) ? current : (plugins[0]?.pluginId ?? null);
}

type ConfigurationUpdate = { readonly key: string; readonly value: string | null };

function legacyConfigurationUpdates(updates: readonly ConfigurationUpdate[]) {
  return updates.map(({ key, value }) => ({ name: key, value }));
}

function configurationRequest(
  plugin: PluginManagerListItem | undefined,
  updates: readonly ConfigurationUpdate[],
): { readonly path: string; readonly init: RequestInit } | undefined {
  if (!plugin || plugin.artifact !== 'installed') return undefined;
  const encodedId = encodeURIComponent(plugin.pluginId);
  if (plugin.source.kind === 'compatibility') {
    const repositoryLocal = plugin.source.adapter === 'repository-local';
    return {
      path: repositoryLocal ? `/api/plugins/${encodedId}/config` : `/api/connectors/${encodedId}/config`,
      init: {
        method: repositoryLocal ? 'POST' : 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          repositoryLocal
            ? { updates: legacyConfigurationUpdates(updates) }
            : { fields: legacyConfigurationUpdates(updates) },
        ),
      },
    };
  }
  if (plugin.lifecycleRevision === null) return undefined;
  return {
    path: `/api/plugin-manager/plugins/${encodedId}/contributions/configuration`,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: plugin.lifecycleRevision, updates }),
    },
  };
}

export function PluginManagerLiveContent() {
  const confirm = useConfirm();
  const [snapshot, setSnapshot] = useState<PluginManagerListResponse | null>(null);
  const [detail, setDetail] = useState<ConsolePluginManagerDetail | undefined>();
  const [busyPluginId, setBusyPluginId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selectedId = useRef<string | null>(null);
  const query = useRef('');
  const listGeneration = useRef(0);
  const detailGeneration = useRef(0);
  const mounted = useRef(true);

  const loadDetail = useCallback(async (pluginId: string, afterMutation = false) => {
    const generation = ++detailGeneration.current;
    try {
      const value = await fetchManagerDetail(pluginId, afterMutation);
      if (!mounted.current || generation !== detailGeneration.current) return;
      setDetail(value);
    } catch {
      if (!mounted.current || generation !== detailGeneration.current) return;
      setDetail(undefined);
    }
  }, []);

  const loadList = useCallback(
    async (search: string, afterMutation = false) => {
      const generation = ++listGeneration.current;
      try {
        const value = await fetchManagerList(search, afterMutation);
        if (!mounted.current || generation !== listGeneration.current) return;
        setSnapshot(value);
        const next = selectedPluginId(value.plugins, selectedId.current);
        selectedId.current = next;
        if (next) await loadDetail(next, afterMutation);
        else setDetail(undefined);
      } catch {
        if (!mounted.current || generation !== listGeneration.current) return;
        setError('插件列表加载失败；现有状态没有被改写。');
      }
    },
    [loadDetail],
  );

  useEffect(() => {
    mounted.current = true;
    void loadList('');
    const timer = window.setInterval(() => void loadList(query.current), POLL_INTERVAL_MS);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
    };
  }, [loadList]);

  const refresh = useCallback(() => loadList(query.current, true), [loadList]);

  const configure = useCallback(
    async (pluginId: string, updates: readonly ConfigurationUpdate[]) => {
      const plugin = snapshot?.plugins.find((candidate) => candidate.pluginId === pluginId);
      const request = configurationRequest(plugin, updates);
      if (!request) {
        setError('该插件没有可用的配置贡献。');
        return;
      }
      setBusyPluginId(pluginId);
      setError(null);
      try {
        const response = await apiFetch(request.path, request.init);
        if (!response.ok) {
          const failure = await responseError(response, `配置保存失败 (${response.status})`);
          setError(failure.message);
          return;
        }
        await refresh();
      } catch {
        setError('配置保存失败；现有配置没有被改写。');
      } finally {
        setBusyPluginId(null);
      }
    },
    [refresh, snapshot],
  );

  const mutate = useCallback(
    async (pluginId: string, path: string, body: unknown) => {
      setBusyPluginId(pluginId);
      setError(null);
      try {
        const response = await apiFetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!response.ok) {
          const failure = await responseError(response, `插件操作失败 (${response.status})`);
          await refresh();
          setError(
            response.status === 409 || failure.code === 'STALE_REVISION'
              ? '插件状态已变化，已刷新最新状态。'
              : failure.message,
          );
          return;
        }
        await refresh();
      } catch {
        setError('插件操作失败；现有状态没有被改写。');
      } finally {
        setBusyPluginId(null);
      }
    },
    [refresh],
  );

  const plugins = snapshot?.plugins ?? [];
  const fixtures = plugins.map((plugin) =>
    designFixture(plugin, detail?.pluginId === plugin.pluginId ? detail : undefined),
  );

  return (
    <PluginManagerContent
      fixtures={fixtures}
      catalogStatus={snapshot?.catalog.status ?? 'fresh'}
      catalogMessage={snapshot?.catalog.message}
      loading={snapshot === null && error === null}
      error={error}
      busyPluginId={busyPluginId}
      onPluginSelect={(pluginId) => {
        selectedId.current = pluginId;
        void loadDetail(pluginId);
      }}
      onSearchChange={(value) => {
        query.current = value;
        void loadList(value);
      }}
      onInstall={(pluginId) => {
        const plugin = plugins.find((candidate) => candidate.pluginId === pluginId);
        if (
          !plugin ||
          plugin.source.kind !== 'catalog' ||
          plugin.availableVersion === null ||
          plugin.packageDigest === null
        ) {
          setError('插件缺少可验证的 catalog release，无法安装。');
          return;
        }
        void mutate(pluginId, '/api/plugin-manager/plugins/install', {
          source: { kind: 'catalog', catalogId: plugin.source.catalogId },
          expectedVersion: plugin.availableVersion,
          expectedDigest: plugin.packageDigest,
        });
      }}
      onSetEnabled={(pluginId, enabled) => {
        const plugin = plugins.find((candidate) => candidate.pluginId === pluginId);
        if (!plugin || plugin.lifecycleRevision === null) {
          setError('插件缺少当前 lifecycle revision，无法变更启用状态。');
          return;
        }
        void mutate(pluginId, `/api/plugin-manager/plugins/${encodeURIComponent(pluginId)}/set-enabled`, {
          enabled,
          expectedRevision: plugin.lifecycleRevision,
        });
      }}
      onUninstall={(pluginId) => {
        const plugin = plugins.find((candidate) => candidate.pluginId === pluginId);
        if (!plugin || plugin.lifecycleRevision === null) {
          setError('插件缺少当前 lifecycle revision，无法卸载。');
          return;
        }
        const operation = plugin.artifact === 'quarantined' ? '移除隔离记录' : '卸载';
        void (async () => {
          const accepted = await confirm({
            title: `${operation}插件`,
            message: `确认${operation} ${plugin.displayName}？`,
            confirmLabel: operation,
            cancelLabel: '取消',
            variant: 'danger',
          });
          if (!accepted) return;
          await mutate(pluginId, `/api/plugin-manager/plugins/${encodeURIComponent(pluginId)}/uninstall`, {
            expectedRevision: plugin.lifecycleRevision,
          });
        })();
      }}
      onConfigure={(pluginId, updates) => void configure(pluginId, updates)}
    />
  );
}
