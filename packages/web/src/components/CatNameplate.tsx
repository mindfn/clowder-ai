'use client';

import { catColorVar } from '@/lib/cat-slug';
import { CatAvatar } from './CatAvatar';

interface CatNameplateProps {
  catId: string;
  /** What the plate calls the cat (the cat's display name as the rest of the message shows it). */
  name: string;
  /** Hover text for the name; defaults to the name itself. */
  title?: string;
  /** Opens the cat's editor, as the avatar in the old bubble layout does. */
  onEditCat?: () => void;
}

/** The plate is 26px high; the face is 32px, laid over its left end. */
const AVATAR_SIZE = 32;
/** The face's bottom edge sits this far below the plate's, so its top is (32 − 26 − 2) = 4px above the plate's. */
const AVATAR_BELOW_PLATE = 2;

/**
 * F322 B — the cat's nameplate at the head of a reply (DESIGN.md「对话」, north-star §1.16 "名牌上的头像").
 *
 * One 26px plate and a 32px face laid over its left end (You chose this one of three sizes on 2026-10-05, because 16px
 * "看不清你们的美貌"): the face's bottom edge is 2px below the plate and its top is above it, and a 2px ring in the work-surface
 * colour separates it from the plate. The face carries no cat-coloured ring: the plate already is the cat's colour, and a ring
 * would mark the same colour twice. The plate leaves 40px on the left for the face and 10px on the right, and the name is
 * 13px / 600. The plate's fill is this cat's surface role in the active theme, fading to transparent from top to bottom, so
 * on one screen a cat is one small patch of colour instead of a framed block. The name is the theme's cat-name role. Both come
 * from the F056 role tokens (`--color-{slug}-surface`, `--color-{slug}-text`), never from a colour written here, so a dark
 * or tuned theme re-colours the plate with the rest of the cat's tokens. The time and the message's badges follow the plate
 * in the header row; they are not part of it.
 */
export function CatNameplate({ catId, name, title, onEditCat }: CatNameplateProps) {
  return (
    <span
      data-testid="cat-nameplate"
      data-cat-id={catId}
      className="relative inline-flex h-[26px] min-w-0 max-w-full shrink items-center rounded-t-lg pl-10 pr-2.5"
      style={{ backgroundImage: `linear-gradient(to bottom, ${catColorVar(catId, 'surface')}, transparent)` }}
    >
      <span
        data-testid="cat-nameplate-avatar"
        className="absolute left-0 rounded-full"
        style={{
          bottom: -AVATAR_BELOW_PLATE,
          width: AVATAR_SIZE,
          height: AVATAR_SIZE,
          boxShadow: '0 0 0 2px var(--shell-work)',
        }}
      >
        <CatAvatar catId={catId} size={AVATAR_SIZE} ring="none" onClick={onEditCat} />
      </span>
      <span
        data-testid="cat-nameplate-name"
        className="min-w-0 truncate text-compact font-semibold"
        style={{ color: catColorVar(catId, 'text') }}
        title={title ?? name}
      >
        {name}
      </span>
    </span>
  );
}
