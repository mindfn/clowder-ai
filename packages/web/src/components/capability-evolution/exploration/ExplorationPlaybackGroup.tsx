import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

type Player = { open(): void; video?: HTMLVideoElement };
type Playback = {
  register(key: string, open: () => void): () => void;
  ready(key: string, video: HTMLVideoElement): void;
  fail(key?: string): void;
};
const PlaybackContext = createContext<Playback | null>(null);
export const useExplorationPlayback = () => useContext(PlaybackContext);

/** A linked pair owns playback only; exact record/media requests remain in ExplorationMedia. */
export function ExplorationPlaybackGroup({ children, enabled = false }: { children: ReactNode; enabled?: boolean }) {
  const players = useRef(new Map<string, Player>());
  const [revision, setRevision] = useState(0);
  const [mode, setMode] = useState<'idle' | 'loading' | 'playing' | 'failed'>('idle');
  const modeRef = useRef(mode);
  const request = useRef<{ started: boolean } | null>(null);
  const pause = useCallback(() => {
    for (const player of players.current.values()) player.video?.pause();
  }, []);
  const stop = useCallback(() => {
    request.current = null;
    modeRef.current = 'idle';
    setMode('idle');
    pause();
  }, [pause]);
  const register = useCallback(
    (key: string, open: () => void) => {
      const player: Player = { open };
      players.current.set(key, player);
      setRevision((value) => value + 1);
      return () => {
        if (players.current.get(key) !== player) return;
        if (modeRef.current === 'playing' || modeRef.current === 'loading') stop();
        players.current.delete(key);
        setRevision((value) => value + 1);
      };
    },
    [stop],
  );
  const ready = useCallback((key: string, video: HTMLVideoElement) => {
    const player = players.current.get(key);
    if (player) {
      player.video = video;
      setRevision((value) => value + 1);
    }
  }, []);
  const fail = useCallback(
    (key?: string) => {
      request.current = null;
      modeRef.current = 'failed';
      setMode('failed');
      pause();
      const player = key ? players.current.get(key) : undefined;
      if (player) delete player.video;
    },
    [pause],
  );
  const context = useMemo(() => ({ register, ready, fail }), [register, ready, fail]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: native metadata updates the mutable player registry; revision is the readiness notification.
  useEffect(() => {
    const active = request.current;
    if (mode !== 'loading' || !active || active.started || players.current.size !== 2) return;
    const videos = [...players.current.values()].map((player) => player.video);
    if (!videos.every((video): video is HTMLVideoElement => Boolean(video && video.readyState >= 1))) return;
    active.started = true;
    for (const video of videos) video.currentTime = 0;
    void Promise.all(videos.map((video) => video.play()))
      .then(() => {
        if (request.current !== active) return;
        modeRef.current = 'playing';
        setMode('playing');
      })
      .catch(() => {
        if (request.current === active) fail();
      });
  }, [mode, revision, fail]);
  const align = useCallback((source: HTMLVideoElement) => {
    if (modeRef.current !== 'playing') return;
    for (const { video } of players.current.values()) {
      if (video && video !== source && Math.abs(video.currentTime - source.currentTime) > 0.1)
        video.currentTime = source.currentTime;
    }
  }, []);
  useEffect(() => {
    if (mode !== 'playing') return;
    const timer = window.setInterval(() => {
      const first = players.current.values().next().value?.video;
      if (first) align(first);
    }, 150);
    return () => window.clearInterval(timer);
  }, [mode, align]);
  useEffect(
    () => () => {
      request.current = null;
      if (modeRef.current === 'playing' || modeRef.current === 'loading') {
        modeRef.current = 'idle';
        pause();
      }
    },
    [pause],
  );
  const begin = () => {
    if (players.current.size !== 2) return;
    request.current = { started: false };
    modeRef.current = 'loading';
    setMode('loading');
    for (const player of players.current.values()) if (!player.video) player.open();
  };
  return (
    <PlaybackContext.Provider value={enabled ? context : null}>
      <div
        className="exploration-playback-group"
        onSeekingCapture={(event) => {
          if (event.target instanceof HTMLVideoElement) align(event.target);
        }}
        onPauseCapture={() => {
          if (modeRef.current === 'playing') stop();
        }}
        onEndedCapture={stop}
      >
        {enabled && (
          <div className="exploration-playback-controls" role="group" aria-label="两段录像联播">
            <button type="button" disabled={players.current.size !== 2 || mode === 'loading'} onClick={begin}>
              两段同步播放
            </button>
            {(mode === 'playing' || mode === 'loading') && (
              <button type="button" onClick={stop}>
                {mode === 'loading' ? '取消联播' : '暂停联播'}
              </button>
            )}
            {mode === 'loading' && <span role="status">正在读取两段原始录像…</span>}
            {mode === 'failed' && <span role="status">联播暂未开始，可重试或分别播放。</span>}
            {players.current.size !== 2 && <span>选择两边的录像后，可以同步播放。</span>}
          </div>
        )}
        <div className="exploration-pair">{children}</div>
      </div>
    </PlaybackContext.Provider>
  );
}
