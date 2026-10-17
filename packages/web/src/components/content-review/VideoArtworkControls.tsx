'use client';

import type { ArtifactReviewAnchor, ImmutableMedia } from '@cat-cafe/shared';
import { type ReactNode, type RefObject, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useArtworkLightboxScope, useFloatingArtworkPresentation } from './ArtworkLightboxScope';
import type { ReviewCanvasMode } from './ReviewCanvasToolbar';
import { browserTimeToTick, tickToBrowserTime } from './review-geometry';

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
type Video = Extract<ImmutableMedia, { kind: 'video' }>;
export function VideoArtworkControls({
  media,
  video,
  seconds,
  frameReady,
  mode,
  canAnnotate,
  canMarkup = false,
  onModeChange,
  onRange,
  onFrame,
  seekTo,
  annotations,
  onAnnotationActive,
  children,
}: {
  media: Video;
  video: RefObject<HTMLVideoElement>;
  seconds: number;
  frameReady: boolean;
  mode: ReviewCanvasMode;
  canAnnotate: boolean;
  canMarkup?: boolean;
  onModeChange: (mode: ReviewCanvasMode) => void;
  onRange: (anchor: ArtifactReviewAnchor) => void;
  onFrame: () => void;
  seekTo: (seconds: number) => void;
  annotations: readonly { id: string; anchor: ArtifactReviewAnchor }[];
  onAnnotationActive: (id: string) => void;
  children: ReactNode;
}) {
  const [rangeOpen, setRangeOpen] = useState(false);
  const [paused, setPaused] = useState(true);
  const [start, setStart] = useState('0'),
    [end, setEnd] = useState('0');
  const floating = useFloatingArtworkPresentation();
  const toolsSlot = useArtworkLightboxScope()?.toolsSlot;
  const duration = tickToBrowserTime(media.startTick + media.durationTicks, media);
  useEffect(() => {
    const node = video.current;
    if (!node) return;
    const update = () => setPaused(node.paused);
    update();
    node.addEventListener('play', update);
    node.addEventListener('pause', update);
    return () => {
      node.removeEventListener('play', update);
      node.removeEventListener('pause', update);
    };
  }, [video]);
  const startTick = browserTimeToTick(Number(start), media),
    endTick = browserTimeToTick(Number(end), media);
  const validRange =
    start !== '' &&
    end !== '' &&
    Number.isFinite(startTick) &&
    Number.isFinite(endTick) &&
    startTick >= media.startTick &&
    endTick <= media.startTick + media.durationTicks &&
    endTick > startTick;
  const tools = (
    <div className="flex flex-wrap items-center gap-2 px-3 py-1" role="toolbar" aria-label="视频批注工具">
      <button
        type="button"
        className="rounded-full border border-cafe-subtle px-3 py-1 text-xs"
        disabled={!canAnnotate}
        aria-expanded={rangeOpen}
        onClick={() => {
          video.current?.pause();
          onModeChange('view');
          setStart(String(seconds));
          setEnd(String(duration));
          setRangeOpen(!rangeOpen);
        }}
      >
        选时间段
      </button>
      <button
        type="button"
        className="rounded-full border border-cafe-subtle px-3 py-1 text-xs"
        disabled={!canAnnotate || !paused || !frameReady}
        aria-pressed={mode === 'comment'}
        onClick={() => {
          setRangeOpen(false);
          onModeChange('comment');
          onFrame();
        }}
      >
        圈这一帧
      </button>
      {!paused || !frameReady ? (
        <span role="status" className="text-xs text-cafe-muted">
          画面还没停稳
        </span>
      ) : null}
      <details className="text-xs">
        <summary aria-label="更多视频工具">⋯</summary>
        <button type="button" disabled={!canMarkup || !paused || !frameReady} onClick={() => onModeChange('markup')}>
          画笔
        </button>
      </details>
      {mode === 'markup' ? children : null}
      {rangeOpen ? (
        <form
          className="flex w-full flex-wrap items-center gap-2 text-xs"
          onSubmit={(event) => {
            event.preventDefault();
            if (!validRange) return;
            onRange({ kind: 'video-range', streamId: media.streamId, startTick, endTick });
            setRangeOpen(false);
          }}
        >
          <label>
            从{' '}
            <input
              aria-label="片段起点"
              className="w-20 rounded border border-cafe-subtle bg-cafe-surface p-1"
              type="number"
              min="0"
              max={duration}
              step="any"
              value={start}
              onChange={(event) => setStart(event.target.value)}
            />
          </label>
          <label>
            到{' '}
            <input
              aria-label="片段终点"
              className="w-20 rounded border border-cafe-subtle bg-cafe-surface p-1"
              type="number"
              min="0"
              max={duration}
              step="any"
              value={end}
              onChange={(event) => setEnd(event.target.value)}
            />
          </label>
          <button
            type="submit"
            disabled={!canAnnotate || !validRange}
            className="rounded border border-cafe-subtle px-2 py-1"
          >
            放入对话
          </button>
        </form>
      ) : null}
    </div>
  );
  return (
    <>
      <div className="shrink-0 px-3 py-2 text-xs" data-testid="artwork-video-timeline">
        <div className="flex items-center gap-3">
          <button
            type="button"
            aria-label={paused ? '播放视频' : '暂停视频'}
            onClick={() => {
              const node = video.current;
              if (!node) return;
              if (node.paused) void node.play().catch(() => {});
              else node.pause();
            }}
          >
            {paused ? '▶' : 'Ⅱ'}
          </button>
          <span className="shrink-0 tabular-nums">
            {clock(seconds)} / {clock(duration)}
          </span>
          <input
            type="range"
            aria-label="视频播放位置"
            className="min-w-0 flex-1"
            min="0"
            max={duration}
            step="any"
            value={seconds}
            onChange={(event) => seekTo(Number(event.target.value))}
          />
        </div>
        {annotations.length ? (
          <div className="relative mt-1 h-5" role="group" aria-label="视频历史批注">
            {annotations.map((item, index) =>
              item.anchor.kind === 'video-range' ? (
                <button
                  type="button"
                  key={item.id}
                  aria-label={`查看批注 ${index + 1}`}
                  className="absolute rounded-full bg-cafe-accent px-1 text-[var(--cafe-surface)]"
                  style={{ left: `${((item.anchor.startTick - media.startTick) / media.durationTicks) * 100}%` }}
                  onClick={() => onAnnotationActive(item.id)}
                >
                  {index + 1}
                </button>
              ) : null,
            )}
          </div>
        ) : null}
      </div>
      {floating && toolsSlot ? createPortal(tools, toolsSlot) : tools}
    </>
  );
}
