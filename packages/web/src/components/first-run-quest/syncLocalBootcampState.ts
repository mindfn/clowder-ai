import type { Thread } from '@/stores/chatStore';
import { useChatStore } from '@/stores/chatStore';

export function syncLocalBootcampState(threadId: string, bootcampState: Thread['bootcampState']) {
  useChatStore.setState((state) => ({
    threads: state.threads.map((thread) => (thread.id === threadId ? { ...thread, bootcampState } : thread)),
  }));
}
