import type { ITaskStore } from '../cats/services/stores/ports/TaskStore.js';
import type { GitHubWaitLifecycleService } from '../github-signals/GitHubWaitLifecycleService.js';

/**
 * Minimal trigger interface — only the subset of ConnectorInvokeTrigger
 * needed by the recovery sweep to dispatch a cat after re-delivering
 * a pending outcome on startup.
 */
export interface RecoveryInvokeTrigger {
  trigger(threadId: string, catId: string, userId: string, message: string, messageId: string): Promise<unknown>;
}

export class WaitLifecycleRecoverySweep {
  constructor(
    private readonly taskStore: ITaskStore,
    private readonly lifecycle: GitHubWaitLifecycleService,
    private readonly log?: {
      info: (...args: unknown[]) => void;
      warn: (...args: unknown[]) => void;
    },
    private readonly invokeTrigger?: RecoveryInvokeTrigger,
  ) {}

  async run(): Promise<{ recovered: number }> {
    let recovered = 0;
    const tasks = [
      ...(await this.taskStore.listByKind('pr_tracking')),
      ...(await this.taskStore.listByKind('issue_tracking')),
    ];
    for (const task of tasks) {
      if (!task.automationState?.waitOutcome) continue;
      try {
        const result = await this.lifecycle.recoverOutcome(task.id);
        recovered += 1;
        // After re-delivering a pending outcome, dispatch the owning cat.
        // Without this, the notification message lands in the thread but
        // no cat is invoked to process it — the gap that caused post-restart
        // notifications to sit unprocessed.
        if (result.kind === 'notified' && this.invokeTrigger && task.ownerCatId && task.userId) {
          try {
            await this.invokeTrigger.trigger(
              task.threadId,
              task.ownerCatId,
              task.userId,
              result.content,
              result.messageId,
            );
            this.log?.info(
              { taskId: task.id, threadId: task.threadId, catId: task.ownerCatId },
              '[F280] recovery sweep dispatched cat for re-delivered outcome',
            );
          } catch (triggerError) {
            this.log?.warn(
              { error: triggerError, taskId: task.id },
              '[F280] recovery sweep dispatch failed; notification delivered but cat not invoked',
            );
          }
        }
      } catch (error) {
        this.log?.warn(
          { error, taskId: task.id },
          '[F280] isolated wait outcome recovery failure; continuing startup sweep',
        );
      }
    }
    return { recovered };
  }
}
