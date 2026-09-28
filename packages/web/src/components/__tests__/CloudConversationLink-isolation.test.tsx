import { act } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { announceCloudBindingChange } from '@/components/cloud-binding-events';
import { apiFetch } from '@/utils/api-client';
import {
  type Candidate,
  connected,
  FakeHost,
  flush,
  gate,
  mountPanel,
  REVIEW,
  STARS,
  serveHosts,
  UNTITLED,
} from './cloud-route-test-fixtures';

/** F202 h3c-1: what reaches the panel from other threads and other surfaces. */

const mockApiFetch = vi.mocked(apiFetch);
let panel: ReturnType<typeof mountPanel>;
let container: HTMLDivElement;
const serve = (...hosts: FakeHost[]) => serveHosts(mockApiFetch, ...hosts);
const show = (threadId: string) => panel.show(threadId);
const status = () => panel.status();
const changeTo = (conversation: Candidate) => panel.changeTo(conversation);

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  mockApiFetch.mockReset();
  panel = mountPanel();
  container = panel.container;
});
afterEach(() => {
  panel.unmount();
  vi.restoreAllMocks();
});
afterAll(() => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe('what reaches the panel from elsewhere', () => {
  it('drops a write still in flight when the owner switches threads', async () => {
    const first = connected(STARS, 'thread-first');
    const second = connected(UNTITLED, 'thread-second');
    const answer = gate();
    first.patchPlan = [{ gate: answer.promise }];
    serve(first, second);
    await show('thread-first');
    await changeTo(REVIEW);

    await show('thread-second');
    answer.open();
    await flush();

    expect(first.bindings['gpt-pro']).toBe(REVIEW.chatUrl);
    expect(status()).toBe('connected');
    expect(container.textContent).toContain(UNTITLED.conversationId);
    expect(container.textContent).not.toContain(REVIEW.displayTitle);
    expect(container.querySelector('[role="alert"], output')).toBeNull();
  });

  it('drops a read-back still in flight when the owner switches threads', async () => {
    const first = connected(STARS, 'thread-first');
    const second = connected(UNTITLED, 'thread-second');
    const readBack = gate();
    first.patchPlan = ['lost'];
    first.readPlan = ['ok', { gate: readBack.promise }];
    serve(first, second);
    await show('thread-first');
    await changeTo(REVIEW);
    expect(status()).toBe('confirming');

    await show('thread-second');
    readBack.open();
    await flush();

    expect(status()).toBe('connected');
    expect(container.textContent).toContain(UNTITLED.conversationId);
    expect(container.querySelector('[role="alert"], output')).toBeNull();
  });

  it('reads the binding again when another surface writes it, after any read already in flight', async () => {
    const host = connected(STARS);
    serve(host);
    await show(host.threadId);

    host.bindings['gpt-pro'] = REVIEW.chatUrl;
    await act(async () => announceCloudBindingChange(host.threadId, 'recovery-card'));
    await flush();

    expect(host.bindingReads()).toHaveLength(2);
    expect(host.bindingReads()[1]?.options).toEqual({ afterCurrentGet: true });
    expect(container.textContent).toContain(REVIEW.displayTitle);

    await act(async () => announceCloudBindingChange('thread-other', 'recovery-card'));
    await flush();
    expect(host.bindingReads()).toHaveLength(2);
  });

  it('reads a change announced during its own write once that write is done', async () => {
    const host = connected(STARS);
    const answer = gate();
    host.patchPlan = [{ gate: answer.promise }];
    serve(host);
    await show(host.threadId);

    await changeTo(REVIEW);
    await act(async () => announceCloudBindingChange(host.threadId, 'recovery-card'));
    expect(host.bindingReads()).toHaveLength(1);

    answer.open();
    await flush();
    expect(host.bindingReads()).toHaveLength(2);
    expect(host.bindingReads()[1]?.options).toEqual({ afterCurrentGet: true });
  });
});
