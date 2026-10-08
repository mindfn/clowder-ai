import { useEffect, useState } from 'react';
import { MemoryProfileProposals } from './MemoryOriginalProposals';
import { MemoryForgetControl, MemoryOwnerFeedback, MemoryOwnerSource } from './MemoryOwnerControls';
import { MemoryReadState } from './MemoryReadState';
import {
  isProfileBrowse,
  isProfileEntry,
  type ProfileMemoryBrowseRead,
  type ProfileMemoryRead,
} from './owner-memory-read';
import { useMemoryOwnerAction } from './use-memory-owner-action';
import { useMemoryRead } from './use-memory-read';

function ProfileDetail({ entry, close, reload }: { entry: ProfileMemoryRead; close: () => void; reload: () => void }) {
  const path = `/api/memory/profile/${encodeURIComponent(entry.id)}`;
  const detail = useMemoryRead<ProfileMemoryRead>(
    `${path}?revision=${encodeURIComponent(entry.revision)}`,
    isProfileEntry,
  );
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(entry.content);
  const action = useMemoryOwnerAction(`${path}/actions`, entry.id, () => {
    close();
    reload();
  });
  const data = detail.data;
  return (
    <aside
      aria-label="画像详情"
      className="space-y-4 rounded-xl border border-cafe-subtle bg-[var(--console-card-bg)] p-4 md:p-6"
    >
      <div className="flex justify-between gap-3">
        <h2 className="text-base font-medium">画像详情</h2>
        <button type="button" onClick={close} className="text-compact text-cafe-accent underline">
          返回画像
        </button>
      </div>
      <MemoryReadState
        loading={detail.loading}
        error={detail.error}
        empty={false}
        noun="画像详情"
        retry={detail.retry}
      />
      <MemoryOwnerFeedback action={action} reread={reload} />
      {data && (
        <>
          <h3 className="text-display-sm">{data.title}</h3>
          <p className="whitespace-pre-wrap break-words text-sm">{data.content}</p>
          <MemoryOwnerSource endpoint={`${path}/source?revision=${encodeURIComponent(data.revision)}`} />
          <MemoryProfileProposals proposals={data.proposals} revision={data.revision} />
          <button
            type="button"
            disabled={action.blocked}
            onClick={() => {
              setContent(data.content);
              setEditing(!editing);
            }}
            className="text-compact text-cafe-accent underline"
          >
            修改画像
          </button>
          {editing && (
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (content.trim())
                  action.submit({ action: 'replace_content', expectedRevision: data.revision, content });
              }}
            >
              <label className="block text-compact">
                画像内容
                <textarea
                  aria-label="画像内容"
                  required
                  maxLength={20000}
                  value={content}
                  onChange={(event) => setContent(event.target.value)}
                  className="mt-1 min-h-40 w-full rounded-lg border border-cafe-subtle bg-cafe-surface-sunken p-3"
                />
              </label>
              <button type="submit" disabled={action.blocked} className="text-compact text-cafe-accent underline">
                保存画像
              </button>
            </form>
          )}
          <MemoryForgetControl revision={data.revision} noun="画像" action={action} retainedAudit />
        </>
      )}
    </aside>
  );
}
export function MemoryProfile({ onReadSummary }: { onReadSummary: (value: string) => void }) {
  const read = useMemoryRead<ProfileMemoryBrowseRead>('/api/memory/profile', isProfileBrowse);
  const [selected, select] = useState<string | null>(null);
  const entries = read.data?.entries ?? [];
  const current = entries.find((entry) => entry.id === selected);
  useEffect(() => {
    onReadSummary(read.loading ? '正在读取' : read.error ? '暂时读不到' : `${read.data?.entries.length ?? 0} 条`);
  }, [read.data, read.error, read.loading, onReadSummary]);
  return (
    <section className="space-y-4" aria-label="画像记忆">
      <header>
        <h1 className="text-display-sm">画像</h1>
        <p className="mt-2 text-compact text-cafe-muted">关于你和我们相处方式的共同画像与关系画像。</p>
      </header>
      <MemoryReadState
        loading={read.loading}
        error={read.error}
        empty={!entries.length}
        noun="画像"
        retry={read.retry}
      />
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <div className={`space-y-3 ${current ? 'hidden lg:block' : ''}`}>
          {entries.map((entry) => (
            <article key={entry.id} className="rounded-xl border border-cafe-subtle bg-[var(--console-card-bg)] p-4">
              <button
                type="button"
                className="text-left text-base font-medium"
                aria-pressed={current?.id === entry.id}
                onClick={() => select(entry.id)}
              >
                {entry.title}
              </button>
              <p className="mt-2 line-clamp-3 break-words text-compact text-cafe-muted">{entry.content}</p>
            </article>
          ))}
        </div>
        {current && (
          <ProfileDetail
            key={`${current.id}:${current.revision}`}
            entry={current}
            close={() => select(null)}
            reload={() => {
              select(null);
              read.retry();
            }}
          />
        )}
      </div>
    </section>
  );
}
