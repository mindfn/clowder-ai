import { defineShellCopy } from '../shell-copy';

export const mailboxEntryCopy = defineShellCopy(
  {
    zh: {
      sections: '待办入口',
      needsMe: '需要我处理',
      schedule: '日程',
      handleAll: (count: number) => `把全部 ${count} 件 @你 请求标为已处理`,
    },
    en: {
      sections: 'Inbox destinations',
      needsMe: 'Needs me',
      schedule: 'Schedule',
      handleAll: (count: number) => `Mark all ${count} @you requests as handled`,
    },
  },
  { samples: { handleAll: [[0], [560]] } },
);
