import { defineShellCopy } from './shell/shell-copy';

/**
 * F322 B (north-star §1.16, 合同三): the one line under the nameplate of a cat that has started and has not written anything
 * yet. It is replaced by the real reply as soon as the first piece of output arrives.
 */
export const pendingMemberCopy = defineShellCopy({
  zh: {
    started: '已开始，还没有输出',
  },
  en: {
    started: 'Started, no output yet',
  },
});
