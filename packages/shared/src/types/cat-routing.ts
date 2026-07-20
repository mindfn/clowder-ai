import type { CatId } from './ids.js';

export interface CatAlternative {
  readonly catId: CatId;
  readonly mention: string;
  readonly displayName: string;
  readonly family: string;
}

export type CatRoutingError =
  | { kind: 'cat_not_found'; mention: string; alternatives: CatAlternative[] }
  | { kind: 'cat_disabled'; catId: CatId; displayName: string; alternatives: CatAlternative[] }
  | { kind: 'target_not_in_thread'; catId: CatId; threadId: string }
  /**
   * F257 #1 (dev-628ea4d1): the mention pattern is held by MORE THAN ONE cat.
   * Routing refuses to guess — candidates carry each holder's unambiguous
   * handle so the sender can retry with an explicit one.
   */
  | { kind: 'mention_ambiguous'; mention: string; candidates: CatAlternative[] };
