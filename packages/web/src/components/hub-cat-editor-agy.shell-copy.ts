import { defineShellCopy } from './shell/shell-copy';

export const agyNativeCopy = defineShellCopy({
  zh: {
    permission: '执行权限',
    restricted: '受限模式',
    automatic: '自动批准（危险模式）',
    automaticDescription: '自动批准文件与命令操作，可访问工作区外的文件。',
    restrictedDescription: '受限模式默认只读，写入需要任务授权。',
    bindingChange: '更换 Profile、模型、账号或执行权限会撤销原任务写入授权。',
  },
  en: {
    permission: 'Execution permissions',
    restricted: 'Restricted',
    automatic: 'Auto-approve (dangerous)',
    automaticDescription: 'Automatically approves file and command operations, including access outside the workspace.',
    restrictedDescription: 'Restricted mode is read-only by default. Writes require task approval.',
    bindingChange: 'Changing the profile, model, account or permission mode revokes previous task write approval.',
  },
});
