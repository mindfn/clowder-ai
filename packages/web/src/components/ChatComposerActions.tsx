'use client';

import type { useVoiceInput } from '@/hooks/useVoiceInput';
import { AppTooltip } from './AppTooltip';
import { chatComposerCopy } from './chat-composer.shell-copy';
import { LoadingIcon } from './icons/LoadingIcon';
import { MicIcon } from './icons/MicIcon';
import { StopRecordingIcon } from './icons/StopRecordingIcon';
import { useShellCopy } from './shell/shell-copy';

type StopState = 'available' | 'pending' | 'unavailable' | 'hidden';
interface ChatComposerActionsProps {
  voice: ReturnType<typeof useVoiceInput>;
  hasText: boolean;
  disabled?: boolean;
  sendDisabled?: boolean;
  showStop: boolean;
  stopState: StopState;
  onStop?: () => void;
  onSend: () => void;
  onQueueSend?: () => void;
  onRequestSteer?: () => void;
}

const control =
  'shell-focusable flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40';

function ComposerVoiceControl({ voice, disabled }: Pick<ChatComposerActionsProps, 'voice' | 'disabled'>) {
  const t = useShellCopy(chatComposerCopy);
  const recording = voice.state === 'recording';
  const transcribing = voice.state === 'transcribing';
  const label = recording ? t.stopRecording : transcribing ? t.transcribing : t.voice;
  const Icon = recording ? StopRecordingIcon : transcribing ? LoadingIcon : MicIcon;
  return (
    <AppTooltip label={label} side="top" shortcut={recording || transcribing ? undefined : '⌥V'}>
      <button
        type="button"
        onClick={recording ? voice.stopRecording : voice.startRecording}
        disabled={transcribing || (!recording && disabled)}
        aria-label={label}
        className={`${control} ${recording ? 'bg-conn-red-text text-[var(--cafe-accent-foreground)] motion-safe:animate-pulse' : 'text-[var(--shell-muted)] hover:bg-[var(--shell-selected)]'}`}
      >
        <Icon className="h-4 w-4" />
      </button>
    </AppTooltip>
  );
}

/** v2 keeps recording separate from sending. The parent retains voice, queue and steer ownership. */
export function ChatComposerActions({
  voice,
  hasText,
  disabled,
  sendDisabled,
  showStop,
  stopState,
  onStop,
  onSend,
  onQueueSend,
  onRequestSteer,
}: ChatComposerActionsProps) {
  const t = useShellCopy(chatComposerCopy);
  const stopLabel = {
    available: t.stop,
    pending: t.stopping,
    unavailable: t.stopUnavailable,
    hidden: t.stop,
  }[stopState];
  const stop = (
    <AppTooltip label={stopLabel} side="top">
      <button
        type="button"
        aria-label={stopLabel}
        onClick={onStop}
        disabled={stopState !== 'available' || !onStop}
        className={`${control} bg-conn-red-text text-[var(--cafe-accent-foreground)] hover:bg-conn-red-hover disabled:cursor-wait`}
      >
        <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
          <rect x="4" y="4" width="12" height="12" rx="2" />
        </svg>
      </button>
    </AppTooltip>
  );
  if (disabled && showStop) return stop;

  const inputBusy = disabled || sendDisabled || voice.state === 'recording' || voice.state === 'transcribing';
  const sendLabel = onQueueSend && hasText ? t.queue : t.send;

  return (
    <>
      {hasText && onRequestSteer && (
        <AppTooltip label={t.force} side="top" multiline>
          <button
            type="button"
            onClick={onRequestSteer}
            disabled={inputBusy}
            aria-label={t.force}
            className={`${control} text-[var(--shell-muted)] hover:bg-[var(--shell-selected)]`}
          >
            <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
              <path d="M11.3 1.046A1 1 0 0 1 12 2v5h4a1 1 0 0 1 .82 1.573l-7 10A1 1 0 0 1 8 18v-5H4a1 1 0 0 1-.82-1.573l7-10a1 1 0 0 1 1.12-.381Z" />
            </svg>
          </button>
        </AppTooltip>
      )}
      <ComposerVoiceControl voice={voice} disabled={disabled} />
      {!hasText && showStop ? (
        stop
      ) : (
        <AppTooltip label={onQueueSend && hasText ? t.queueHint : t.send} side="top">
          <button
            type="button"
            onClick={onQueueSend ?? onSend}
            disabled={inputBusy || !hasText}
            aria-label={sendLabel}
            className={`${control} bg-[var(--shell-primary)] text-[var(--shell-primary-on)] hover:brightness-95`}
          >
            <svg
              aria-hidden="true"
              className="h-4 w-4"
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M10 16V4m-5 5 5-5 5 5" />
            </svg>
          </button>
        </AppTooltip>
      )}
    </>
  );
}
