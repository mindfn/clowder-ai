import { defineShellCopy } from './shell/shell-copy';

export const freshnessNoticeCopy = defineShellCopy(
  {
    zh: {
      pending: (count: number) => `生成期间有 ${count} 条新消息，等待补充检查`,
      running: (count: number) => `正在核对生成期间的 ${count} 条新消息…`,
      committed: '已核对，并在下方追加了补充',
      declined: '已核对，无需补充',
      failed: (reason: string) => `新消息补读失败：${reason} 这条回复已保留，新消息尚未完成自动核对。`,
      offerFailed: (reason: string) => `补充检查未能安排：${reason} 这条回复已保留，新消息尚未完成自动核对。`,
      exhausted: (count: number) => `；另有 ${count} 条更新超出自动检查上限`,
      unseen: (count: number) => `此回复生成期间有 ${count} 条新消息`,
      unknown: '未能确认此回复生成期间的消息边界',
      scanning: '正在核对生成期间的消息边界…',
      unknownReason: '暂时无法取得失败原因。',
      reasons: {
        provider_failure: '模型服务调用失败。',
        user_cancel: '检查已被取消。',
        quota: '本次检查的可用额度不足。',
        queue_full: '检查队列已满。',
        scheduler_unavailable: '后台调度暂不可用。',
        read_only_policy_unavailable: '当前运行方式不支持安全的只读检查。',
        tool_policy_violation: '检查被工具权限限制阻止。',
        infrastructure: '后台检查服务暂不可用。',
      },
    },
    en: {
      pending: (count: number) => `${count} new messages arrived during this reply; an update check is pending`,
      running: (count: number) => `Checking the ${count} new messages that arrived during this reply…`,
      committed: 'Checked; an update was added below',
      declined: 'Checked; no update needed',
      failed: (reason: string) =>
        `New-message check failed: ${reason} This reply is preserved; the new messages have not been fully checked.`,
      offerFailed: (reason: string) =>
        `Could not schedule the new-message check: ${reason} This reply is preserved; the new messages have not been fully checked.`,
      exhausted: (count: number) => `; another ${count} updates exceeded the automatic check limit`,
      unseen: (count: number) => `${count} new messages arrived during this reply`,
      unknown: 'Could not confirm which messages arrived during this reply',
      scanning: 'Checking which messages arrived during this reply…',
      unknownReason: 'The failure reason is currently unavailable.',
      reasons: {
        provider_failure: 'The model service call failed.',
        user_cancel: 'The check was canceled.',
        quota: 'There was insufficient quota for this check.',
        queue_full: 'The check queue was full.',
        scheduler_unavailable: 'The background scheduler is unavailable.',
        read_only_policy_unavailable: 'The current runtime cannot enforce a read-only check.',
        tool_policy_violation: 'Tool permissions prevented the check.',
        infrastructure: 'The background check service is unavailable.',
      },
    },
  },
  {
    samples: {
      pending: [[1], [3]],
      running: [[1], [3]],
      failed: [['First failure.'], ['Second failure.']],
      offerFailed: [['First failure.'], ['Second failure.']],
      exhausted: [[1], [3]],
      unseen: [[1], [3]],
    },
  },
);
