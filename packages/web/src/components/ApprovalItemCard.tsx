'use client';

import type { ApprovalHubItem } from '@cat-cafe/shared';
import { GenericApprovalItemCard } from './GenericApprovalItemCard';
import { MeetingIntakeCard } from './MeetingIntakeCard';
import { MemoryCorrectionApprovalCard } from './memory/page/MemoryCorrectionApprovalCard';
import { DomainApprovalCard, isDomainApprovalFeature } from './rich/DomainApprovalCard';
import { EvalRepairApprovalCard } from './rich/EvalRepairApprovalCard';
import { PersonMemoryApprovalCard } from './rich/PersonMemoryApprovalCard';
import { ScheduleMutationProposalCard } from './rich/ScheduleMutationProposalCard';

/**
 * Feature-owned adapter dispatch for the Approval Hub.
 *
 * F292 keeps its feature-owned business adapter while both adapter paths
 * supply data and actions to the shared presentation-only ApprovalDecisionCard.
 */
export function ApprovalItemCard({ item }: { item: ApprovalHubItem }) {
  if (item.sourceFeatureId === 'F276') return <PersonMemoryApprovalCard item={item} />;
  if (item.sourceFeatureId === 'F292') return <MeetingIntakeCard item={item} />;
  if (item.sourceFeatureId === 'F321') return <MemoryCorrectionApprovalCard item={item} />;
  if (item.sourceFeatureId === 'F139') return <ScheduleMutationProposalCard item={item} />;
  if (item.sourceFeatureId === 'F266') return <EvalRepairApprovalCard item={item} />;
  if (isDomainApprovalFeature(item.sourceFeatureId)) return <DomainApprovalCard item={item} />;
  return <GenericApprovalItemCard item={item} />;
}
