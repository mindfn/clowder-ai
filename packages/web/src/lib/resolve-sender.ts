/**
 * Unified sender resolution — co-creator is a first-class member.
 *
 * Replaces the repeated `senderCatId === null ? coCreator : getCatById(...)` branching
 * scattered across ReplyPill, ReplyPreviewBar, SummaryCard, MessageNavigator, etc.
 *
 * Usage:
 *   const sender = resolveSender(senderCatId, getCatById, coCreator);
 *   // sender.label  → "@宪宪" | "始皇帝" | "@unknown-cat"
 *   // sender.color  → resolved primary color (the identity fill), always non-null
 *   // sender.textColor → the colour to write text in: the readable name role for the co-creator, else the cat colour
 *   //                    (a cat's name role too, when the caller asks for it: `{ nameRole: true }`, new shell only)
 */

import type { CoCreatorConfig } from '@/components/config-viewer-types';
import type { CatData } from '@/hooks/useCatData';
import { formatCatDisplayName } from '@/lib/cat-display-name';
import { catColorVar } from '@/lib/cat-slug';
import { CO_CREATOR_COLOR, UNKNOWN_CAT_COLOR } from '@/lib/color-defaults';

export interface SenderMeta {
  /** Display label: "@猫名" for cats, co-creator name for user, "@rawId" for unknown */
  label: string;
  /** Resolved primary color — always a valid hex string. An identity fill, which may be dark in a dark theme. */
  color: string;
  /**
   * The colour to write text in, as a CSS colour. A cat's identity colour doubles as its text colour unless the caller asks
   * for the name role (see `ResolveSenderOptions`); the co-creator's is configurable (and cocoa by default), so their text
   * always uses the shared name role, which the theme keeps readable.
   */
  textColor: string;
  /** true when sender is the co-creator (senderCatId was null) */
  isCoCreator: boolean;
}

export interface ResolveSenderOptions {
  /**
   * Write a known cat in its readable name role (`--color-{cat}-text`, the token the message name uses) instead of in its
   * identity hex. The identity colour stays `color`, the fill that says who; only the text changes, so it reads on the
   * surface the theme draws. For the new shell only: classic is frozen, so the default is off and a caller that does not ask
   * gets the hex it always got. An unknown id has no token to point at and keeps its fallback hex.
   */
  nameRole?: boolean;
}

/**
 * Resolve any senderCatId to display metadata.
 *
 * - `null` → co-creator (co-creator is a member too)
 * - known catId → cat display name + cat color
 * - unknown catId → raw ID + fallback color
 */
export function resolveSender(
  senderCatId: string | null,
  getCatById: (id: string) => CatData | undefined,
  coCreator: CoCreatorConfig,
  options: ResolveSenderOptions = {},
): SenderMeta {
  // Co-creator — first-class member, not a "null fallback"
  if (senderCatId === null) {
    return {
      label: coCreator.name,
      color: coCreator.color?.primary ?? CO_CREATOR_COLOR.primary,
      textColor: 'var(--color-cocreator-text)',
      isCoCreator: true,
    };
  }

  // Known cat
  const cat = getCatById(senderCatId);
  if (cat) {
    return {
      label: `@${formatCatDisplayName(cat)}`,
      color: cat.color.primary,
      textColor: options.nameRole ? catColorVar(cat.id, 'text') : cat.color.primary,
      isCoCreator: false,
    };
  }

  // Unknown cat ID
  return {
    label: `@${senderCatId}`,
    color: UNKNOWN_CAT_COLOR.primary,
    textColor: UNKNOWN_CAT_COLOR.primary,
    isCoCreator: false,
  };
}
