import { defineShellCopy } from './shell-copy';

export const threadMetadataCopy = defineShellCopy({
  zh: {
    open: '对话设置',
    title: '对话设置',
    pin: '置顶这条对话',
    pinned: '已置顶',
    feature: '关联 Feature',
    noFeature: '不关联 Feature',
    loading: '正在读取对话设置…',
    loadFailed: '对话设置没有读到。',
    saveFailed: '保存失败，原设置保持不变。',
    retry: '重试',
  },
  en: {
    open: 'Conversation settings',
    title: 'Conversation settings',
    pin: 'Pin this conversation',
    pinned: 'Pinned',
    feature: 'Linked Feature',
    noFeature: 'No linked Feature',
    loading: 'Loading conversation settings…',
    loadFailed: 'Conversation settings could not be loaded.',
    saveFailed: 'Saving failed. The previous settings are unchanged.',
    retry: 'Retry',
  },
});
