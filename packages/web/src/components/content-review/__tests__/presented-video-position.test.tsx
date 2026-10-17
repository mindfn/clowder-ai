import { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ArtworkLightboxProvider } from '../ArtworkLightboxScope';
import { usePresentedVideoFrame } from '../usePresentedVideoFrame';

it('retains the same source playhead across presentation remounts, while requiring fresh frame evidence and isolating revisions', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let frameTime: number | null = null;
  function Player({ identity }: { identity: string }) {
    const video = useRef<HTMLVideoElement>(null);
    frameTime = usePresentedVideoFrame(video, '/original-media', identity).frameTime;
    // biome-ignore lint/a11y/useMediaCaption: This metadata-only test player never loads media.
    return <video ref={video} />;
  }
  const render = (key: string, identity = 'review:revision-1:stream-0') =>
    act(async () =>
      root.render(
        <ArtworkLightboxProvider threadId="original-thread">
          <Player key={key} identity={identity} />
        </ArtworkLightboxProvider>,
      ),
    );
  try {
    await render('floating');
    const original = host.querySelector('video');
    if (!original) throw new Error('original player missing');
    Object.defineProperty(original, 'readyState', { value: 4 });
    original.currentTime = 82;
    await act(async () => original.dispatchEvent(new Event('timeupdate')));
    await render('work-mode');
    const next = host.querySelector('video');
    if (!next) throw new Error('work-mode player missing');
    const pause = vi.spyOn(next, 'pause').mockImplementation(() => {});
    Object.defineProperty(next, 'readyState', { value: 1 });
    await act(async () => next.dispatchEvent(new Event('loadedmetadata')));
    expect(next).not.toBe(original);
    expect(next.currentTime).toBe(82);
    expect(pause).toHaveBeenCalled();
    expect(frameTime).toBeNull(); // A retained playhead is never a presented-frame receipt.
    await render('new-version', 'review:revision-2:stream-0');
    const replacement = host.querySelector('video');
    if (!replacement) throw new Error('new-version player missing');
    Object.defineProperty(replacement, 'readyState', { value: 1 });
    await act(async () => replacement.dispatchEvent(new Event('loadedmetadata')));
    expect(replacement.currentTime).toBe(0);
    expect(frameTime).toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  }
});
