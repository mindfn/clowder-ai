import { defineShellCopy } from './shell/shell-copy';

export const messageDispositionCopy = defineShellCopy({
  zh: {
    settings: {
      heading: '默认发送方式',
      note: '猫正在工作时，新消息默认排到下一件工作，或引导当前回复。每条对话仍可在输入框的 + 菜单里单独选择。',
      nextLabel: '下一件工作',
      nextNote: '等当前一轮结束后自然开始',
      continueLabel: '接着当前工作',
      continueNote: '支持引导且有可追加的回复时，进入当前回复；否则排队等待',
      loading: '正在读取默认发送方式…',
      loadFailed: '默认发送方式没读到。',
      saving: '正在保存…',
      saveFailed: '默认发送方式没有保存，请重试。',
      retry: '重试',
    },
  },
  en: {
    settings: {
      heading: 'Default send mode',
      note: 'While a cat is working, new messages either wait as the next work or guide the current reply. Each conversation can still choose separately from the composer’s + menu.',
      nextLabel: 'Next work',
      nextNote: 'Start naturally after the current work finishes',
      continueLabel: 'Continue current work',
      continueNote:
        'Join the current reply when guidance is supported and append is available; otherwise wait in the queue',
      loading: 'Loading the default send mode…',
      loadFailed: 'The default send mode could not be loaded.',
      saving: 'Saving…',
      saveFailed: 'The default send mode could not be saved. Try again.',
      retry: 'Try again',
    },
  },
});
