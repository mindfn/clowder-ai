import type { LifecycleDispatchRef } from '@cat-cafe/shared';

function formatReceiptTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const part = (value: number) => String(value).padStart(2, '0');
  return `${part(date.getMonth() + 1)}/${part(date.getDate())} ${part(date.getHours())}:${part(date.getMinutes())}:${part(date.getSeconds())}`;
}

/** Status/time belongs to the exact dispatch; names and content belong to each view. */
export function dispatchReceiptDisplay(ref: LifecycleDispatchRef | undefined, running: boolean) {
  const receipt = ref?.inputRead;
  if (receipt?.status === 'read') return { state: 'read', timestamp: formatReceiptTimestamp(receipt.at), pulse: false };
  const timestamp =
    typeof ref?.dispatchedAt === 'number' && Number.isFinite(ref.dispatchedAt)
      ? formatReceiptTimestamp(ref.dispatchedAt)
      : undefined;
  if (!receipt) return { state: 'unavailable', timestamp, pulse: false };
  return { state: running ? 'pending' : 'unconfirmed', timestamp, pulse: running };
}

export function dispatchReceiptLabel(
  receipt: ReturnType<typeof dispatchReceiptDisplay>,
  name: string,
  view: 'recipient' | 'appended_source',
): string {
  const read = receipt.state === 'read';
  const status =
    view === 'recipient' ? (read ? `已读 ${name}` : `已投递 ${name}`) : read ? `已读 ${name}` : `已收到 ${name}`;
  const unconfirmed = receipt.state === 'unconfirmed' ? '（未确认读取）' : '';
  const time = receipt.timestamp === undefined ? '' : ` · ${receipt.timestamp}`;
  return `${status}${unconfirmed}${time}`;
}
