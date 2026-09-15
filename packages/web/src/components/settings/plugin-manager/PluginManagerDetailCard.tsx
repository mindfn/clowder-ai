'use client';

import { resolvePluginDescription } from '@cat-cafe/shared';
import { useState } from 'react';
import { ExternalLinkIcon, type PlatformFieldStatus, StepBadge } from '../../HubConfigIcons';
import { HubIcon } from '../../hub-icons';
import { MarkdownContent } from '../../MarkdownContent';
import { settingsResourceCardClass, settingsResourceRowClass } from '../../SettingsResourceCard';
import { ConfigFieldRenderer } from '../primitives/ConfigFieldRenderer';
import { SettingsText } from '../primitives/SettingsText';
import { PluginVisual } from './PluginVisual';
import type { PluginManagerDesignFixture } from './plugin-manager-fixtures';

function SectionHeading({ children }: { children: string }) {
  return (
    <SettingsText as="h4" variant="xs" tone="muted" className="font-semibold">
      {children}
    </SettingsText>
  );
}

const contributionKindLabel: Record<string, string> = {
  mcp: 'MCP',
  schedule: 'Scheduler',
  skill: 'Skill',
  'direct-tool': 'Tool',
  limb: 'Limb',
  webhook: 'Webhook',
  messaging: 'Messaging',
  events: 'Events',
  identity: 'Identity',
  connector: 'Connector',
  service: 'Service',
  ui: 'UI',
};

interface CapabilityDocItem {
  key: string;
  kind: string;
  name: string;
  description?: string;
}

function capabilityDescription(
  plugin: PluginManagerDesignFixture,
  kind: string,
  description: string | undefined,
): string | undefined {
  if (description !== undefined) return description;
  if (kind !== 'mcp') return '插件未提供用途说明。';
  if (plugin.live !== 'running') return '启用插件后显示工具及用途。';
  return plugin.tools === undefined ? undefined : '插件未提供用途说明。';
}

function CapabilityDocRow({
  plugin,
  kind,
  item,
}: {
  plugin: PluginManagerDesignFixture;
  kind: string;
  item: CapabilityDocItem;
}) {
  const description = capabilityDescription(plugin, kind, item.description);
  return (
    <li className="rounded-xl bg-cafe-surface-sunken px-3 py-2.5">
      <SettingsText as="p" variant="sm" tone="default" className="font-medium">
        {item.name}
      </SettingsText>
      {description !== undefined && (
        <SettingsText as="p" variant="xs" tone="secondary" className="mt-0.5">
          {description}
        </SettingsText>
      )}
    </li>
  );
}

function capabilityDocItems(plugin: PluginManagerDesignFixture): CapabilityDocItem[] {
  return (plugin.contributions ?? []).flatMap((contribution) => {
    const tools =
      contribution.kind === 'mcp' ? (plugin.tools ?? []).filter((tool) => tool.contributionId === contribution.id) : [];
    if (tools.length > 0) {
      return tools.map((tool) => ({
        key: `${contribution.id}:${tool.name}`,
        kind: 'mcp',
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
      }));
    }
    return [
      {
        key: contribution.id,
        kind: contribution.kind,
        name: contribution.name,
        ...(contribution.description === undefined ? {} : { description: contribution.description }),
      },
    ];
  });
}

function groupCapabilityDocs(items: readonly CapabilityDocItem[]) {
  const groups = new Map<string, CapabilityDocItem[]>();
  for (const item of items) {
    const group = groups.get(item.kind) ?? [];
    group.push(item);
    groups.set(item.kind, group);
  }
  return [...groups].map(([kind, groupedItems]) => ({ kind, items: groupedItems }));
}

function CapabilityDocumentation({
  plugin,
  installed,
  groups,
}: {
  plugin: PluginManagerDesignFixture;
  installed: boolean;
  groups: readonly { kind: string; items: CapabilityDocItem[] }[];
}) {
  return (
    <section className="space-y-3" data-plugin-detail-section="capability-docs">
      <SectionHeading>能力说明</SectionHeading>
      {plugin.readmeUnavailable === true ? (
        <SettingsText as="p" variant="sm" tone="muted">
          README 暂不可用。
        </SettingsText>
      ) : plugin.readmeMarkdown === undefined ? (
        <SettingsText as="p" variant="sm" tone="muted">
          此版本未随插件包提供 README。
        </SettingsText>
      ) : (
        <MarkdownContent content={plugin.readmeMarkdown} disableCommandPrefix />
      )}
      {plugin.docsUrl && (
        <a href={plugin.docsUrl} target="_blank" rel="noopener noreferrer" className="console-inline-link">
          <ExternalLinkIcon />
          <span>查看插件文档</span>
        </a>
      )}
      {plugin.contributions === undefined ? (
        <SettingsText as="p" variant="sm" tone="muted">
          {installed ? '能力信息暂不可用。' : '安装后可查看具体工具与用途。'}
        </SettingsText>
      ) : groups.length > 0 ? (
        <div className="space-y-3">
          {groups.map(({ kind, items }) => (
            <section key={kind} className="space-y-1.5" data-contribution-kind={kind}>
              <SettingsText as="h5" variant="xs" tone="muted" className="font-semibold">
                {contributionKindLabel[kind] ?? kind}
              </SettingsText>
              {kind === 'mcp' && plugin.live === 'running' && plugin.tools === undefined && (
                <SettingsText as="p" variant="xs" tone="muted">
                  工具信息暂不可用。
                </SettingsText>
              )}
              <ul className="space-y-1.5">
                {items.map((item) => (
                  <CapabilityDocRow key={item.key} plugin={plugin} kind={kind} item={item} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      ) : (
        <SettingsText as="p" variant="sm" tone="muted">
          此插件未声明可展示的工具或资源。
        </SettingsText>
      )}
    </section>
  );
}

export function PluginManagerDetailCard({
  plugin,
  locale,
  busy = false,
  onSaveConfig,
}: {
  plugin: PluginManagerDesignFixture;
  locale: string;
  busy?: boolean;
  onSaveConfig?: (updates: readonly { key: string; value: string | null }[]) => void;
}) {
  const installed = plugin.artifact === 'installed';
  const description = resolvePluginDescription(plugin.description, locale);
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const capabilityItems = capabilityDocItems(plugin);
  const capabilityGroups = groupCapabilityDocs(capabilityItems);
  const updates = (plugin.configFields ?? []).flatMap((field) => {
    const value = fieldValues[field.key];
    return value === undefined ? [] : [{ key: field.key, value: value.length === 0 ? null : value }];
  });

  const renderField = (
    field: NonNullable<PluginManagerDesignFixture['configFields']>[number],
  ): PlatformFieldStatus => ({
    envName: field.key,
    label: field.label,
    sensitive: field.sensitive,
    type:
      field.kind === 'select'
        ? 'select'
        : field.kind === 'boolean'
          ? 'toggle'
          : field.kind === 'list'
            ? 'list'
            : 'input',
    ...(field.kind === 'number' || field.kind === 'url' ? { inputType: field.kind } : {}),
    ...(field.options === undefined ? {} : { options: field.options.map(({ value, label }) => ({ value, label })) }),
    currentValue: field.currentValue,
  });

  return (
    <article data-testid="plugin-manager-detail" className={settingsResourceCardClass}>
      <div className="space-y-5 p-4">
        <section className="space-y-2.5" data-plugin-detail-section="identity">
          <SectionHeading>插件标识</SectionHeading>
          <div className={`${settingsResourceRowClass} w-full px-0 py-0`}>
            <PluginVisual icon={plugin.icon} iconBg={plugin.iconBg} name={plugin.displayName} size="large" />
            <div className="min-w-0 flex-1">
              <SettingsText as="h3" variant="sm" tone="default" className="font-semibold">
                {plugin.displayName}
              </SettingsText>
              <SettingsText as="p" variant="xs" tone="muted" className="mt-0.5 break-all">
                {plugin.installedVersion ?? plugin.availableVersion} · {plugin.packageName} · {plugin.publisher}
              </SettingsText>
            </div>
          </div>
        </section>

        <section className="space-y-2" data-plugin-detail-section="introduction">
          <SectionHeading>插件简介</SectionHeading>
          <SettingsText as="p" variant="sm" tone="secondary">
            {description}
          </SettingsText>
        </section>

        {plugin.diagnostic && (
          <div className="flex items-start gap-2 rounded-xl bg-conn-amber-bg px-3 py-2.5">
            <HubIcon name="alert-triangle" className="mt-0.5 h-4 w-4 shrink-0 text-conn-amber-text" />
            <SettingsText as="p" variant="sm" tone="amber">
              {plugin.diagnostic}
            </SettingsText>
          </div>
        )}

        <section className="space-y-3" data-plugin-detail-section="configuration">
          <SectionHeading>插件配置</SectionHeading>
          {installed ? (
            <>
              {plugin.setupSteps?.map((step, index) => (
                <div key={step} className="flex items-center gap-1.5">
                  <StepBadge num={index + 1} />
                  <SettingsText as="span" variant="sm" tone="default" className="font-medium">
                    {step}
                  </SettingsText>
                </div>
              ))}

              {plugin.configFields && plugin.configFields.length > 0 && (
                <div className="space-y-2.5">
                  <div className="flex items-center gap-1.5">
                    <StepBadge num={(plugin.setupSteps?.length ?? 0) + 1} />
                    <SettingsText as="span" variant="sm" tone="default" className="font-medium">
                      填写插件配置
                    </SettingsText>
                  </div>
                  <div className="ml-[26px] space-y-2.5">
                    {plugin.configFields.map((field) => (
                      <ConfigFieldRenderer
                        key={field.key}
                        field={renderField(field)}
                        value={fieldValues[field.key] ?? ''}
                        onChange={(key, value) => setFieldValues((current) => ({ ...current, [key]: value }))}
                        idPrefix={`plugin-manager-${plugin.id}`}
                      />
                    ))}
                  </div>
                </div>
              )}
              {!plugin.configFields?.length && !plugin.setupSteps?.length && (
                <SettingsText as="p" variant="sm" tone="muted">
                  此插件无需额外配置。
                </SettingsText>
              )}
            </>
          ) : (
            <SettingsText as="p" variant="sm" tone="muted">
              安装后可查看并填写插件配置。
            </SettingsText>
          )}

          {installed && plugin.configFields && plugin.configFields.length > 0 && onSaveConfig && (
            <div className="flex justify-end">
              <button
                type="button"
                className="console-button-primary disabled:opacity-50"
                disabled={busy || updates.length === 0}
                onClick={() => onSaveConfig(updates)}
              >
                {busy ? '保存中...' : '保存配置'}
              </button>
            </div>
          )}
        </section>

        <CapabilityDocumentation plugin={plugin} installed={installed} groups={capabilityGroups} />
      </div>
    </article>
  );
}
