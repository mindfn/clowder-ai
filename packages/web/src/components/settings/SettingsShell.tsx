'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useState } from 'react';
import { HubIcon } from '../hub-icons';
import { SettingsContent } from './SettingsContent';
import { SettingsNav } from './SettingsNav';
import { DEFAULT_SECTION, SETTINGS_SECTIONS } from './settings-nav-config';

function SettingsShellInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeSection = searchParams.get('s') ?? DEFAULT_SECTION;
  const [searchQuery, setSearchQuery] = useState('');

  const handleSelect = useCallback(
    (sectionId: string) => {
      router.replace(`/settings?s=${sectionId}`, { scroll: false });
    },
    [router],
  );

  const sectionMeta = SETTINGS_SECTIONS.find((s) => s.id === activeSection) ?? SETTINGS_SECTIONS[0];

  return (
    <div className="console-shell flex h-full min-h-0 flex-col gap-4 overflow-hidden p-4 md:flex-row md:gap-5 md:p-5">
      <aside
        className="console-shell-panel flex w-full flex-shrink-0 flex-col overflow-hidden rounded-[30px] md:w-[19.5rem]"
        data-console-panel="settings-nav"
      >
        <div className="px-4 pb-3 pt-4 md:px-5 md:pb-4 md:pt-5">
          <div className="console-shell-panel-soft rounded-[24px] px-4 py-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-cafe-muted">Console</p>
              <span className="console-pill inline-flex items-center rounded-full px-3 py-1 text-[11px] font-semibold text-cafe-secondary">
                {SETTINGS_SECTIONS.length} sections
              </span>
            </div>
            <div className="mt-2 flex items-center justify-between gap-3">
              <div>
                <h1 className="text-[1.35rem] font-semibold tracking-[-0.03em] text-cafe">设置</h1>
                <p className="mt-1 text-sm text-cafe-secondary">像系统偏好设置一样整理成员、能力和运行环境。</p>
              </div>
              <div
                className="console-pill flex h-11 w-11 items-center justify-center rounded-[18px] text-cafe"
                style={{ color: sectionMeta.color }}
              >
                <HubIcon name={sectionMeta.icon} className="h-5 w-5" />
              </div>
            </div>
          </div>
        </div>
        <div className="px-4 pb-4 md:px-5">
          <div className="console-search-field relative rounded-full px-3">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-cafe-muted">
              <HubIcon name="search" className="h-3.5 w-3.5" />
            </span>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索配置..."
              className="w-full bg-transparent py-2.5 pl-7 pr-3 text-sm text-cafe placeholder:text-cafe-muted focus:outline-none"
              data-testid="settings-search"
            />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 md:px-4">
          <SettingsNav activeSection={activeSection} onSelect={handleSelect} searchQuery={searchQuery} />
        </div>
      </aside>

      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[68rem] space-y-4 pb-5">
          <section className="console-shell-panel rounded-[32px] px-5 py-5 md:px-7 md:py-6">
            <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
              <div className="space-y-2">
                <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-cafe-muted">Settings</p>
                <div className="flex flex-wrap items-center gap-3">
                  <h2 className="text-[2rem] font-semibold tracking-[-0.05em] text-cafe md:text-[2.35rem]">
                    {sectionMeta.label}
                  </h2>
                  <span
                    className="console-pill inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold"
                    style={{ color: sectionMeta.color }}
                  >
                    {sectionMeta.id}
                  </span>
                </div>
                <p className="max-w-2xl text-sm leading-6 text-cafe-secondary">{sectionMeta.description}</p>
              </div>
            </div>
          </section>

          <div className="px-1 md:px-0">
            <SettingsContent section={activeSection} />
          </div>
        </div>
      </div>
    </div>
  );
}

export function SettingsShell() {
  return (
    <Suspense>
      <SettingsShellInner />
    </Suspense>
  );
}
