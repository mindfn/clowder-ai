'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback } from 'react';
import { SettingsContent } from './SettingsContent';
import { SettingsNav } from './SettingsNav';
import { DEFAULT_SECTION, SETTINGS_SECTIONS } from './settings-nav-config';

function SettingsShellInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeSection = searchParams.get('s') ?? DEFAULT_SECTION;

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
        <SettingsNav activeSection={activeSection} onSelect={handleSelect} />
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
