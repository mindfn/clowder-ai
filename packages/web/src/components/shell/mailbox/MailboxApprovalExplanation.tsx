import type { ApprovalHubItem } from '@cat-cafe/shared';
import { useCatNameResolver } from '@/hooks/useCatNameResolver';

const EFFECT: Partial<Record<ApprovalHubItem['sourceFeatureId'], string>> = {
  F128: '按提议创建对话。',
  F193: '把这条工作交给提议中的执行者。',
  F139: '按提议设置定时任务。',
  F221: '保存这条品味。',
  F260: '按提议登记或更新实体。',
  F266: '采用这条评估修复提议。',
  F321: '采用这条记忆整理提议。',
};

/** Only producer-supplied words identify the reason and executor. Absence is displayed, never filled with an invented claim. */
export function MailboxApprovalExplanation({ item }: { item: ApprovalHubItem }) {
  const name = useCatNameResolver();
  const reason = ['reason', 'rationale', 'content', 'takeaway', 'description']
    .map((key) => item.detail[key])
    .find((value) => typeof value === 'string' && value.trim());
  const cats = item.detail.targetCats ?? item.detail.preferredCats;
  const executors =
    Array.isArray(cats) && cats.every((cat) => typeof cat === 'string') ? cats.map(name).join('、') : '';
  return (
    <div className="space-y-2 text-sm" data-testid="mailbox-proposal-explanation">
      <p className="m-0">提议者：{name(item.requesterCatId)}</p>
      <div>
        <p className="m-0 font-medium">为什么</p>
        <p className="m-0 whitespace-pre-wrap break-words">
          {typeof reason === 'string' ? reason : '原提议未说明原因'}
        </p>
      </div>
      <p className="m-0">执行者：{executors || '原提议未指定'}</p>
      <p className="m-0">同意后：{EFFECT[item.sourceFeatureId] ?? '按原提议执行；结果以实际回执为准。'}</p>
    </div>
  );
}
