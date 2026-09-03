import type { QueueReceiptTarget } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';
import { receiptTargetStateLabel } from '../queue-receipt-projection';

function target(state: QueueReceiptTarget['state'], invocationId?: string): QueueReceiptTarget {
  return { catId: 'opus', state, ...(invocationId ? { invocationId } : {}) };
}

describe('queue receipt terminal labels', () => {
  it('does not advertise an in-place retry for immutable terminal Queue work', () => {
    expect(receiptTargetStateLabel(target('cancelled'), new Set())).toBe('执行已停止');
    expect(receiptTargetStateLabel(target('failed', 'inv-1'), new Set())).toBe('执行失败');
    expect(receiptTargetStateLabel(target('failed'), new Set())).toBe('唤醒失败');
    expect(receiptTargetStateLabel(target('withdrawn'), new Set())).toBe('通知未送达 · 关联事项已结束');
  });
});
