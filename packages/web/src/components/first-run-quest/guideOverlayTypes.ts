import type { BootcampStateV1 } from '@/stores/chat-types';

export type GuideStep =
  | 'preview-result'
  | 'open-hub'
  | 'click-add-member'
  | 'fill-form'
  | 'done'
  | 'return-to-chat'
  | 'mention-teammate';

export type BootcampState = BootcampStateV1 & {
  guideStep?: GuideStep | null;
  [key: string]: unknown;
};
