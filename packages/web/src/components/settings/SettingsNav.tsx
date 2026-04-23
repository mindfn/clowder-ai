'use client';

import { HubIcon } from '../hub-icons';
import { SETTINGS_SECTIONS, type SettingsSection } from './settings-nav-config';

interface SettingsNavProps {
  activeSection: string;
  onSelect: (sectionId: string) => void;
}

function NavItem({ section, active, onSelect }: { section: SettingsSection; active: boolean; onSelect: () => void }) {
  return (
    <button
      onClick={onSelect}
      className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors
        ${
          active
            ? 'bg-cafe-surface font-medium shadow-sm'
            : 'text-cafe-secondary hover:bg-cafe-surface-elevated hover:text-cafe'
        }`}
      style={active ? { color: section.color } : undefined}
    >
      <span style={active ? { color: section.color } : { color: '#9ca3af' }}>
        <HubIcon name={section.icon} className="h-4 w-4" />
      </span>
      <span>{section.label}</span>
    </button>
  );
}

export function SettingsNav({ activeSection, onSelect }: SettingsNavProps) {
  return (
    <nav className="flex flex-col gap-0.5 px-2 py-3" aria-label="设置导航">
      {SETTINGS_SECTIONS.map((section) => (
        <NavItem
          key={section.id}
          section={section}
          active={section.id === activeSection}
          onSelect={() => onSelect(section.id)}
        />
      ))}
    </nav>
  );
}
