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
    <div className="flex h-full bg-cafe-surface-sunken">
      {/* Left navigation */}
      <div className="w-52 flex-shrink-0 border-r border-cafe-border bg-cafe-surface-elevated overflow-y-auto">
        <div className="px-4 pt-4 pb-2">
          <h1 className="text-base font-semibold text-cafe">设置</h1>
        </div>
        <div className="px-3 pb-2">
          <div className="relative">
            <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-cafe-muted">
              <HubIcon name="search" className="h-3.5 w-3.5" />
            </span>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索配置..."
              className="w-full rounded-lg border border-cafe-border bg-cafe-surface pl-8 pr-3 py-1.5 text-xs text-cafe placeholder:text-cafe-muted focus:outline-none focus:ring-1 focus:ring-cocreator-primary"
              data-testid="settings-search"
            />
          </div>
        </div>
        <SettingsNav activeSection={activeSection} onSelect={handleSelect} searchQuery={searchQuery} />
      </div>

      {/* Right content area */}
      <div className="flex-1 min-w-0 overflow-y-auto">
        <div className="max-w-4xl mx-auto px-6 py-5">
          <h2 className="text-lg font-semibold text-cafe mb-4">{sectionMeta.label}</h2>
          <SettingsContent section={activeSection} />
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
