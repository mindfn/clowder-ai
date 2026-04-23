'use client';

import { HubIcon } from '../hub-icons';
import { SETTINGS_SECTIONS, type SettingsSection } from './settings-nav-config';

interface SettingsNavProps {
  activeSection: string;
  onSelect: (sectionId: string) => void;
  searchQuery?: string;
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

const SECTION_KEYWORDS: Record<string, string> = {
  members: '猫猫 成员 名册 roster cat',
  accounts: '密钥 API key 账号 credentials',
  im: '飞书 钉钉 企微 telegram 微信 connector',
  skills: 'skill 技能 能力 marketplace',
  mcp: 'MCP tool 工具',
  plugins: '插件 集成 GitHub PR email calendar',
  voice: '语音 TTS STT whisper',
  system: '配置 环境 .env bubble A2A codex',
  notify: '推送 通知 push web',
  ops: '运维 监控 排行 记忆 健康 命令 救援 usage',
};

export function SettingsNav({ activeSection, onSelect, searchQuery }: SettingsNavProps) {
  const q = searchQuery?.toLowerCase().trim() ?? '';
  const filtered = q
    ? SETTINGS_SECTIONS.filter(
        (s) =>
          s.label.toLowerCase().includes(q) ||
          s.id.toLowerCase().includes(q) ||
          (SECTION_KEYWORDS[s.id] ?? '').toLowerCase().includes(q),
      )
    : SETTINGS_SECTIONS;

  return (
    <nav className="flex flex-col gap-0.5 px-2 py-3" aria-label="设置导航">
      {filtered.length === 0 && q ? (
        <p className="px-3 py-2 text-xs text-cafe-muted">没有匹配的设置分区</p>
      ) : (
        filtered.map((section) => (
          <NavItem
            key={section.id}
            section={section}
            active={section.id === activeSection}
            onSelect={() => onSelect(section.id)}
          />
        ))
      )}
    </nav>
  );
}
