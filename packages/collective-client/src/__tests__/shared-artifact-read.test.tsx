// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { ClientRequest } from '../client-request.js';
import type { ClientSnapshot } from '../client-types.js';
import type { collectiveArtifactClient, SharedArtifact, SharedMarkdownView } from '../collective-artifact-client.js';
import { SharedArtifactCatalogueReconciled } from '../collective-artifact-client.js';
import { useCollectiveArtifacts } from '../use-collective-artifacts.js';
import { useSharedArtifactRead } from '../use-shared-artifact-read.js';
import { snapshot } from './first-entry-fixture.js';

const blobDigest = `sha256:${'a'.repeat(64)}`;
const artifact: SharedArtifact = {
  serviceInstanceId: 'service',
  collectiveId: 'collective',
  artifactId: 'shared',
  contentRef: 'same-owner',
  publishedByHumanId: 'publisher',
  title: '共同作品',
  mediaType: 'text/markdown',
  sourceEventId: 'source',
  sourceLocation: { channelId: 'general' },
  revision: 1,
  accessRevision: 1,
  canApply: false,
  availability: 'available',
  versionCount: 1,
  versions: [{ ownerRevision: 1, blobDigest, receiptRef: 'receipt', recordedAt: '2026-10-16T00:00:00Z' }],
  createdAt: '2026-10-16T00:00:00Z',
  updatedAt: '2026-10-16T00:00:00Z',
};
const host = document.createElement('div');
const root = createRoot(host);
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
afterEach(async () => {
  await act(async () => root.render(null));
  sessionStorage.clear();
});

it('never sends a retained media selection to the Markdown body reader', async () => {
  const read = vi.fn(async () => {
    throw new Error('Markdown cannot decode media');
  });
  const api = { read } as unknown as ReturnType<typeof collectiveArtifactClient>;
  function Harness() {
    useSharedArtifactRead(api, { ...artifact, mediaType: 'image/png' }, 1, 'ready');
    return null;
  }
  await act(async () => root.render(<Harness />));
  expect(read).not.toHaveBeenCalled();
});

it('does not restart an in-flight multi-page owner read when the regular catalogue poll returns the same authority', async () => {
  let finish!: (view: SharedMarkdownView) => void;
  const read = vi.fn(
    () =>
      new Promise<SharedMarkdownView>((resolve) => {
        finish = resolve;
      }),
  );
  const api = { read } as unknown as ReturnType<typeof collectiveArtifactClient>;
  function Harness({ target, denied = false }: { target: SharedArtifact; denied?: boolean }) {
    const result = useSharedArtifactRead(api, target, undefined, denied ? 'access_denied' : 'ready');
    return <div>{result.view?.text}</div>;
  }
  await act(async () => root.render(<Harness target={artifact} />));
  await act(async () => root.render(<Harness target={structuredClone(artifact)} />));
  expect(read).toHaveBeenCalledTimes(1);
  await act(async () =>
    finish({
      text: '所有分页已读完',
      contentRef: artifact.contentRef,
      ownerRevision: 1,
      blobDigest,
      view: { historyReadOnly: false },
    } as SharedMarkdownView),
  );
  expect(host.textContent).toBe('所有分页已读完');
  sessionStorage.setItem('valid-human-session', 'retained');
  await act(async () => root.render(<Harness target={artifact} denied />));
  expect(host.textContent).toBe('');
  expect(sessionStorage.getItem('valid-human-session')).toBe('retained');
  await act(async () => root.render(<Harness target={artifact} />));
  expect(host.textContent).toBe('');
  expect(read).toHaveBeenCalledTimes(2);
});

it('cannot let an old publication callback refresh the previous collective over the newly selected world', async () => {
  let current!: ReturnType<typeof useCollectiveArtifacts>;
  const request: ClientRequest = async <Result,>(_path: string, init?: RequestInit) => {
    const input = JSON.parse(String(init?.body));
    return {
      artifacts: [{ ...artifact, serviceInstanceId: input.serviceInstanceId, collectiveId: input.collectiveId }],
    } as Result;
  };
  function Harness({ value }: { value: ClientSnapshot }) {
    current = useCollectiveArtifacts(value, request);
    return null;
  }
  await act(async () => root.render(<Harness value={snapshot} />));
  const oldRefresh = current.refresh;
  if (!snapshot.collective) throw new Error('Expected an existing world');
  const next = { ...snapshot, collective: { ...snapshot.collective, collectiveId: 'col_87654321' } };
  await act(async () => root.render(<Harness value={next} />));
  expect(current.catalogue[0]?.collectiveId).toBe(next.collective.collectiveId);
  await act(async () => oldRefresh());
  expect(current.catalogue[0]?.collectiveId).toBe(next.collective.collectiveId);
});

it('refreshes the catalogue immediately after historical receipt recovery before displaying a latest-version view', async () => {
  const refresh = vi.fn(async () => {});
  const read = vi.fn(async () => {
    throw new SharedArtifactCatalogueReconciled();
  });
  const api = { read } as unknown as ReturnType<typeof collectiveArtifactClient>;
  function Harness() {
    const result = useSharedArtifactRead(api, artifact, undefined, 'ready', refresh);
    return <div>{result.view?.text}</div>;
  }
  await act(async () => root.render(<Harness />));
  expect(refresh).toHaveBeenCalledOnce();
  expect(host.textContent).toBe('');
});
