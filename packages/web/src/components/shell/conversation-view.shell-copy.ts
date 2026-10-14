import { defineShellCopy } from './shell-copy';

export const conversationViewCopy = defineShellCopy({
  zh: {
    group: '群聊',
    menuLabel: '切换对话视图',
    currentView: '当前视图',
    loading: '正在恢复视图…',
    loadFailed: '视图暂未恢复，当前显示群聊',
    saveFailed: '保存失败，请重试',
    readUnavailable: '读取记录暂不可用',
    working: '正在工作',
  },
  en: {
    group: 'Group chat',
    menuLabel: 'Switch conversation view',
    currentView: 'Current view',
    loading: 'Restoring view…',
    loadFailed: 'The view could not be restored; showing Group chat',
    saveFailed: 'Could not save. Try again',
    readUnavailable: 'Read records temporarily unavailable',
    working: 'Working',
  },
});
