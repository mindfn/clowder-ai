import type { CatId } from '@cat-cafe/shared';
import type { AgentMessage, AgentService, AgentServiceOptions, ProviderContinuityPreflight } from '../../types.js';
import { AgentSessionBridgeService } from './AgentSessionBridgeService.js';
import type { SessionImplementationRef, SessionImplementationRegistry } from './implementation-registry.js';
import { sessionImplementationKey } from './implementation-registry.js';
import type { AgentSessionProvider } from './types.js';

interface RegisteredInput {
  catId: CatId;
  ref: SessionImplementationRef;
  registry: SessionImplementationRegistry;
  metadata?: { provider: string; model: string };
  log?: { info(...a: unknown[]): void; warn(...a: unknown[]): void };
}
export class RegisteredSessionAgentService implements AgentService {
  private cached?: { provider: AgentSessionProvider; bridge: AgentSessionBridgeService; lifetime: AbortController };
  constructor(private readonly input: RegisteredInput) {}
  get implementationKey(): string {
    return sessionImplementationKey(this.input.ref);
  }
  invoke(prompt: string, options?: AgentServiceOptions): AsyncIterable<AgentMessage> {
    return this.run(prompt, options);
  }
  invokeWithContinuityPreflight(
    preflight: ProviderContinuityPreflight,
    options?: AgentServiceOptions,
  ): AsyncIterable<AgentMessage> {
    return this.run(preflight, options);
  }
  async releaseAll(reason: string): Promise<void> {
    const cached = this.cached;
    this.cached = undefined;
    cached?.lifetime.abort();
    await cached?.bridge.releaseAll(reason);
  }
  private async *run(
    prompt: string | ProviderContinuityPreflight,
    options?: AgentServiceOptions,
  ): AsyncIterable<AgentMessage> {
    const provider = this.input.registry.resolve(this.input.ref, { catId: this.input.catId });
    const metadata = { ...(this.input.metadata ?? { provider: 'session-contract', model: 'unknown' }) };
    let code: string | undefined;
    if (!provider) {
      await this.releaseAll('implementation_unavailable');
      code = 'session_implementation_unavailable';
    } else if (!options?.hostSessionId) code = 'host_session_unavailable';
    if (code) {
      for (const type of ['error', 'done'] as const)
        yield {
          type,
          errorCode: code,
          ...(type === 'error'
            ? {
                error:
                  code === 'session_implementation_unavailable' && 'pluginId' in this.input.ref
                    ? `绑定的 ACP client 暂不可用（${this.input.ref.pluginId}/${this.input.ref.contributionId}）。请在设置 → 插件集成中检查配置并启用插件，或为成员选择其他 client。`
                    : code,
              }
            : {}),
          catId: this.input.catId,
          metadata: { ...metadata },
          timestamp: Date.now(),
        };
      return;
    }
    let cached = this.cached;
    if (!cached || cached.provider !== provider) {
      const previous = this.cached;
      cached = {
        provider: provider as AgentSessionProvider,
        lifetime: new AbortController(),
        bridge: new AgentSessionBridgeService({
          ...this.input,
          provider: provider as AgentSessionProvider,
          passHostOptions: true,
          resolveHostSession: (opts) => ({
            sessionId: opts?.hostSessionId ?? '',
            resumeNativeSessionId: opts?.sessionId,
          }),
        }),
      };
      this.cached = cached;
      previous?.lifetime.abort();
      await previous?.bridge.releaseAll('implementation_replaced');
    }
    if (cached.lifetime.signal.aborted) {
      yield {
        type: 'done',
        catId: this.input.catId,
        timestamp: Date.now(),
        metadata: { ...metadata },
        errorCode: 'cancelled',
      };
      return;
    }
    const signal = AbortSignal.any([cached.lifetime.signal, ...(options?.signal ? [options.signal] : [])]);
    this.input.log?.info({ catId: this.input.catId }, '[session-contract] bridged');
    yield* typeof prompt === 'string'
      ? cached.bridge.invoke(prompt, { ...options, signal })
      : cached.bridge.invokeWithContinuityPreflight(prompt, { ...options, signal });
  }
}

export const selectSessionAgentService = <T>(
  ref: SessionImplementationRef | undefined,
  registered: (ref: SessionImplementationRef) => T,
  existing: () => T,
): T => (ref ? registered(ref) : existing());
