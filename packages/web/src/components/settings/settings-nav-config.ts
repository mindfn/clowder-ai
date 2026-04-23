export interface SettingsSection {
  id: string;
  label: string;
  icon: string;
  color: string;
}

export const SETTINGS_SECTIONS: SettingsSection[] = [
  { id: 'members', label: '成员管理', icon: 'users', color: '#9B7EBD' },
  { id: 'accounts', label: '账户与密钥', icon: 'key', color: '#9B7EBD' },
  { id: 'im', label: 'IM 对接', icon: 'zap', color: '#E29578' },
  { id: 'skills', label: 'Skill 管理', icon: 'sparkles', color: '#E29578' },
  { id: 'mcp', label: 'MCP 管理', icon: 'terminal', color: '#E29578' },
  { id: 'plugins', label: '插件/集成', icon: 'store', color: '#E29578' },
  { id: 'voice', label: '语音管理', icon: 'mic', color: '#5B9BD5' },
  { id: 'system', label: '系统配置', icon: 'settings', color: '#5B9BD5' },
  { id: 'notify', label: '通知', icon: 'bell', color: '#5B9BD5' },
  { id: 'ops', label: '运维监控', icon: 'activity', color: '#5B9BD5' },
];

export const DEFAULT_SECTION = 'members';
