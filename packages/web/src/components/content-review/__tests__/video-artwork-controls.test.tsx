import type { ImmutableMedia } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { VideoArtworkControls } from '../VideoArtworkControls';

const media: Extract<ImmutableMedia, { kind: 'video' }> = {
  kind: 'video',
  width: 1280,
  height: 720,
  codedWidth: 1280,
  codedHeight: 720,
  rotation: 0,
  pixelAspectRatio: { numerator: 1, denominator: 1 },
  streamIndex: 0,
  containerStartSeconds: 0,
  streamId: 'original-stream',
  timebase: { numerator: 1, denominator: 15360 },
  startTick: 0,
  durationTicks: 5197824,
};
let root: Root, container: HTMLDivElement, video: HTMLVideoElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  video = document.createElement('video');
  vi.spyOn(video, 'pause').mockImplementation(() => {});
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
it('keeps circle disabled until an actually presented paused frame is ready and returns a selected range in original ticks', async () => {
  const onRange = vi.fn(),
    onFrame = vi.fn();
  const props = {
    media,
    video: { current: video },
    seconds: 82,
    mode: 'view' as const,
    canAnnotate: true,
    onModeChange: vi.fn(),
    onRange,
    onFrame,
    seekTo: vi.fn(),
    annotations: [],
    onAnnotationActive: vi.fn(),
    children: null,
  };
  await act(async () => root.render(<VideoArtworkControls {...props} frameReady={false} />));
  const buttons = () => [...container.querySelectorAll('button')];
  expect(buttons().find((b) => b.textContent === '圈这一帧')?.disabled).toBe(true);
  expect(container.textContent).toContain('画面还没停稳');
  await act(async () => root.render(<VideoArtworkControls {...props} frameReady />));
  expect(buttons().find((b) => b.textContent === '圈这一帧')?.disabled).toBe(false);
  await act(async () =>
    buttons()
      .find((b) => b.textContent === '选时间段')
      ?.click(),
  );
  expect(onRange).not.toHaveBeenCalled();
  await act(async () =>
    container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
  expect(onRange).toHaveBeenCalledExactlyOnceWith({
    kind: 'video-range',
    streamId: 'original-stream',
    startTick: 1259520,
    endTick: 5197824,
  });
  expect(onFrame).not.toHaveBeenCalled();
});
