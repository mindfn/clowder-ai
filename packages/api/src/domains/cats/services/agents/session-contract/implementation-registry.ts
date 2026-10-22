import type { CatId } from '@cat-cafe/shared';
import type { AgentSessionProvider } from './types.js';

export type SessionImplementationRef = { builtin: string } | { pluginId: string; contributionId: string };
export function sessionImplementationKey(ref: SessionImplementationRef): string {
  return 'builtin' in ref ? `builtin:${ref.builtin}` : `plugin:${ref.pluginId}/${ref.contributionId}`;
}
type Factory = (ctx: { catId: CatId }) => AgentSessionProvider;
export class SessionImplementationRegistry {
  private readonly factories = new Map<string, { factory: Factory }>();
  register(ref: SessionImplementationRef, factory: Factory): () => void {
    const key = sessionImplementationKey(ref);
    if (this.factories.has(key)) throw new Error(`Duplicate session implementation: ${key}`);
    const entry = { factory };
    this.factories.set(key, entry);
    return () => {
      if (this.factories.get(key) === entry) this.factories.delete(key);
    };
  }
  resolve(ref: SessionImplementationRef, ctx: { catId: CatId }): AgentSessionProvider | undefined {
    return this.factories.get(sessionImplementationKey(ref))?.factory(ctx);
  }
  has(ref: SessionImplementationRef): boolean {
    return this.factories.has(sessionImplementationKey(ref));
  }
}
