import { useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

/** Message owner holds the last receipt; navigation, reload and browser storage do not own its lifetime. */
export function MailboxMentionUndo({
  owner,
  disabled = false,
  visible = true,
}: {
  owner: string | undefined;
  disabled?: boolean;
  visible?: boolean;
}) {
  const [receipt, setReceipt] = useState<{ undoId: string; handled: number; remaining: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    setReceipt(null);
    setNotice(null);
    if (!owner) return;
    let live = true;
    let generation = 0;
    const load = async () => {
      const current = ++generation;
      try {
        const response = await apiFetch('/api/concierge/work/mentions/last-handling');
        if (!response.ok) throw new Error('无法读取撤销记录，请重试。');
        const body = await response.json();
        if (!live || current !== generation) return;
        if (body.ownerUserId !== owner) throw new Error('撤销记录归属未确认。');
        const value = body.receipt;
        if (
          value !== null &&
          (typeof value?.undoId !== 'string' ||
            !Number.isSafeInteger(value?.handled) ||
            value.handled < 1 ||
            !Number.isSafeInteger(value.remaining) ||
            value.remaining < 0 ||
            value.remaining > value.handled)
        )
          throw new Error('撤销记录不可用。');
        setReceipt(value);
      } catch (e) {
        if (live && current === generation) {
          setReceipt(null);
          setNotice(e instanceof Error ? e.message : '无法读取撤销记录。');
        }
      }
    };
    void load();
    window.addEventListener('cat-cafe:user-mention-updated', load);
    return () => {
      live = false;
      window.removeEventListener('cat-cafe:user-mention-updated', load);
    };
  }, [owner]);
  async function undo() {
    if (!receipt) return;
    setBusy(true);
    try {
      const response = await apiFetch('/api/concierge/work/mentions/undo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ undoId: receipt.undoId }),
      });
      if (!response.ok) throw new Error('撤销已不可用，请重新读取记录。');
      const result = await response.json();
      setNotice(
        `已撤销 ${result.restored} 件。${result.restored < receipt.remaining ? '有后续变化的对话保留当前状态。' : ''}`,
      );
      setReceipt(null);
      window.dispatchEvent(new Event('cat-cafe:user-mention-updated'));
    } catch (e) {
      setNotice(e instanceof Error ? e.message : '未能撤销，请重试。');
    } finally {
      setBusy(false);
    }
  }
  if (!owner || !visible) return null;
  return (
    <div className="mb-2 text-xs">
      {receipt && receipt.remaining > 0 ? (
        <button
          type="button"
          className="shell-nav-row shell-focusable rounded-lg px-2 py-1 text-xs disabled:opacity-50"
          disabled={disabled || busy}
          onClick={() => void undo()}
          data-testid="mailbox-mentions-undo"
        >
          撤销刚才的批量处理（{receipt.remaining < receipt.handled ? '剩 ' : ''}
          {receipt.remaining} 件）
        </button>
      ) : null}
      {notice ? (
        <p role="status" className="m-0">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
