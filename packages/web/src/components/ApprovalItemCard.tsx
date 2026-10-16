'use client';

import type { ApprovalHubItem } from '@cat-cafe/shared';
import { GenericApprovalItemCard } from './GenericApprovalItemCard';

/** Render current Host approvals through the shared presentation card. */
export function ApprovalItemCard({ item }: { item: ApprovalHubItem }) {
  return <GenericApprovalItemCard item={item} />;
}
