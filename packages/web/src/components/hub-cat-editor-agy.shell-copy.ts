import { defineShellCopy } from './shell/shell-copy';

export const agyNativeCopy = defineShellCopy({
  zh: {
    permission: '执行权限',
    restricted: '受限模式',
    automatic: '自动批准（危险模式）',
    automaticDescription: '自动批准文件与命令操作，可访问工作区外的文件；系统保护范围和只读限制仍然有效。',
    restrictedDescription:
      '在批准的工作区内启用原生沙箱，可读取文件并调用获准的 MCP 工具。文件写入和所有命令（含只读命令）会被直接拒绝；如需这些操作，请选择自动批准。',
    bindingChange: '设置变更后会重新核验会话；无法续接时新建会话，已有历史消息保留。',
  },
  en: {
    permission: 'Execution permissions',
    restricted: 'Restricted',
    automatic: 'Auto-approve (dangerous)',
    automaticDescription:
      'Automatically approves file and command operations, including access outside the workspace. System protections and read-only restrictions still apply.',
    restrictedDescription:
      'Uses the native sandbox in approved workspaces. Can read files and call permitted MCP tools. File writes and all shell commands, including read-only commands, are denied outright. Choose auto-approve to enable these operations.',
    bindingChange:
      'Setting changes recheck session compatibility. A new session starts when needed; existing messages are kept.',
  },
});
