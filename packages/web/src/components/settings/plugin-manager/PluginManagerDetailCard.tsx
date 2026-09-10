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

        <section className="space-y-3" data-plugin-detail-section="capability-docs">
          <SectionHeading>能力说明</SectionHeading>
          {plugin.readmeMarkdown === undefined ? (
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
          {plugin.capabilities.length > 0 ? (
            <div className="space-y-2" role="group" aria-label="已声明能力">
              <SettingsText as="p" variant="xs" tone="muted" className="font-semibold">
                已声明能力
              </SettingsText>
              {plugin.capabilities.map((capability) => (
                <div key={capability.name} className="rounded-xl bg-cafe-surface-sunken px-3 py-2.5">
                  <SettingsText as="p" variant="sm" tone="default" className="font-medium">
                    {capability.name}
                  </SettingsText>
                  <SettingsText as="p" variant="xs" tone="secondary" className="mt-0.5">
                    {capability.description}
                  </SettingsText>
                </div>
              ))}
            </div>
          ) : null}
        </section>
      </div>
    </article>
  );
}
