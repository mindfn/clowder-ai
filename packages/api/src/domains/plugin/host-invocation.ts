import type { M0CDeliverInput, M0CDeliverResult } from '@clowder-ai/plugin-contract';

/** The published Host→plugin messaging row, independent of its runtime carrier. */
export interface HostMessagingDeliveryPort {
  deliver(targetId: string, input: M0CDeliverInput): Promise<M0CDeliverResult>;
}
