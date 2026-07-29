import type { FrictionRollupSourceSelector } from '@cat-cafe/shared';
import type { Redis } from 'ioredis';
import type { CapabilityWakeupSourceSelector } from '../capability-wakeup/capability-wakeup-trial-provider.js';
import type { QcMetricsSelector } from '../qc-metrics-provider.js';
import type { SopTraceInput } from '../sop/sop-trace-adapter.js';
import type { TaskOutcomeVerdict } from '../task-outcome/task-outcome-episode.js';
import type { VerdictHandoffPacket } from '../verdict-handoff.js';

/**
 * F257 / F192 sunset: neutral artifact publisher contract. The publisher owns
 * durable publication of verdict artifacts (verdict.md + bundle/) to a store that is
 * NOT the product Git repository. Eval Hub read-model reads from the same store.
 */
export interface ArtifactRef {
  /** Stable identifier for this verdict artifact. */
  artifactId: string;
  /** Domain slug derived from packet.domainId (e.g. 'eval-a2a'). */
  domainSlug: string;
  /** Absolute path to the committed verdict.md. */
  verdictPath: string;
  /** Absolute path to the committed bundle directory. */
  bundleDir: string;
  /** Stable reference that can be stored or returned to callers. */
  artifactUrl: string;
}

export interface PublishArtifactOpts {
  packet: VerdictHandoffPacket;
  sourceRefs: VerdictSourceRefs;
  /**
   * Generator callback. The publisher creates a temporary output directory and
   * passes it to the generator; the generator must write verdict.md + bundle/
   * under that directory. The publisher atomically publishes the directory to the
   * artifact store and then runs afterPublish (if provided) exactly once.
   *
   * The caller closes over any GeneratorDeps the generator needs; the publisher
   * is storage-agnostic.
   */
  generate: (outputRoot: string) => Promise<{
    verdictPath: string;
    bundleDir: string;
    extraStagedPaths?: string[];
    afterPublish?: () => void | Promise<void>;
  }>;
}

export interface ArtifactPublisher {
  publishArtifact(opts: PublishArtifactOpts): Promise<ArtifactRef>;
}

/**
 * a2a evidence refs — basenames of pre-sanitized YAML files. `kind` is OPTIONAL
 * for backward compat (existing cats publish without specifying kind, default
 * interpretation is a2a snapshot/attribution refs).
 *
 * 砚砚 R2 P2 cloud: must be basename (NOT path) — handler resolves under allowlist.
 */
export interface A2aSnapshotAttributionRefs {
  kind?: 'a2a-snapshot-attribution';
  /** Basename of sanitized eval snapshot YAML inside `<harnessFeedbackRoot>/snapshots/`. */
  snapshotName?: string;
  /** Basename of sanitized attribution YAML inside `<harnessFeedbackRoot>/attributions/`. */
  attributionName?: string;
}

/**
 * F192 PR1 — task-outcome replayable snapshot selector. The real generator is
 * not wired yet; PR1 only reserves the schema/type surface so handler + MCP
 * tool can validate the shape honestly before PR2 flips the wire.
 */
export interface TaskOutcomeSnapshotSourceRefs {
  kind: 'task-outcome-snapshot';
  windowStartMs: number;
  windowEndMs: number;
  databasePath?: string;
  evidenceCatId?: string;
  /**
   * Optional explicit 7-class episode verdict writeback. Packet-level verdict
   * remains the shared 4-class harness judgement; these entries are per-episode
   * labels assigned by the eval cat after reading the replay window.
   */
  episodeVerdicts?: Array<{
    episodeId: string;
    verdict: TaskOutcomeVerdict;
  }>;
}

/**
 * F192 publish_verdict eval:memory wire-up — replayable recall metrics selector.
 * Provider (`MemoryMetricsProvider`) resolves selector → live recall metrics +
 * library health snapshot. Generator writes them into bundle/snapshot.json +
 * raw inputs at `<repoRoot>/generated/memory/<verdictId>/`.
 */
export interface MemoryRecallSourceSelector {
  kind: 'memory-recall-snapshot';
  /** Inclusive window in days [1, 90] — recall API ceiling. */
  windowDays: number;
  /** Optional — restrict to a specific cat id. */
  catId?: string;
  /** Optional — restrict to a specific recall tool. */
  toolName?: string;
}

/**
 * F192 sop-wiring — replayable SOP trace selector. Eval cat builds the trace
 * from session observation; generator replays evaluation via predicate evaluator
 * and writes provenance artifacts. Trace is embedded (no persistent SOP trace
 * store yet), so the selector carries the full SopTraceInput.
 */
export interface SopTraceSourceSelector {
  kind: 'sop-trace-eval';
  /** Which SOP definition to evaluate against (e.g. 'development'). */
  sopDefinitionId: string;
  /** The full trace data for deterministic replay. */
  trace: SopTraceInput;
}

/**
 * F236 Track-2 AC-E4 — replayable anchor telemetry rollup selector for eval:anchor-first.
 * Provider resolves this window selector → getAnchorTelemetryRollup(window) → rollup
 * snapshot with per-tool open-rate, charsSaved, drillChars, double-sided netBenefit.
 * Shape mirrors FrictionRollupSourceSelector (window + kind discriminator).
 */
export interface AnchorTelemetrySourceSelector {
  kind: 'anchor-telemetry-snapshot';
  /** Window start (inclusive), epoch ms */
  windowStartMs: number;
  /** Window end (exclusive), epoch ms; must be > windowStartMs */
  windowEndMs: number;
}

/**
 * F257 Phase A Line B — replayable prompt-segments guard rejection selector for eval:harness-ledger.
 * Provider resolves this window selector → GuardRejectionEventLog.queryWindow → events.
 * Shape follows the standard window pattern (like anchor-telemetry, qc-metrics, friction).
 */
export interface PromptSegmentsSourceSelector {
  kind: 'prompt-segments';
  /** Window start (inclusive), epoch ms */
  windowStartMs: number;
  /** Window end (exclusive), epoch ms; must be > windowStartMs */
  windowEndMs: number;
  /**
   * KD-17 snapshot-first: trigger pre-produces a run snapshot and passes
   * this ID so the generator reads the SAME stored data (single-read,
   * no re-query). Generator fails closed on missing snapshot.
   * Format: `hlr-<timestamp>-<hex8>` — validated at MCP + generator layer.
   */
  evalRunId: string;
  /** Optional guard ID filter (e.g. 'hold_ball_rate_limit'). */
  guardId?: string;
}

/**
 * F192 Phase H 收尾 PR-2 — `VerdictSourceRefs` is a discriminated union (砚砚 R1 Q3).
 * - a2a branch: `{snapshotName, attributionName}` (kind optional, default a2a)
 * - capability-wakeup branch: `CapabilityWakeupSourceSelector` (kind required)
 * - task-outcome branch: `TaskOutcomeSnapshotSourceRefs` (kind required, PR1 schema-only)
 * - memory branch: `MemoryRecallSourceSelector` (kind required, memory wire-up)
 * - sop branch: `SopTraceSourceSelector` (kind required, sop-wiring)
 * - friction branch: `FrictionRollupSourceSelector` (kind required, F245 PR1b live sink)
 * - anchor-telemetry branch: `AnchorTelemetrySourceSelector` (kind required, F236 Track-2)
 * - qc branch: `QcMetricsSelector` (kind required, F253 Phase C)
 * - prompt-segments branch: `PromptSegmentsSourceSelector` (kind required, F257 Phase A Line B)
 *
 * 砚砚 R1 P1 #2: generator MUST receive explicit `sources` (sanitized
 * evidence refs / replayable selector); tool NEVER fabricates evidence.
 */
export type VerdictSourceRefs =
  | A2aSnapshotAttributionRefs
  | CapabilityWakeupSourceSelector
  | TaskOutcomeSnapshotSourceRefs
  | MemoryRecallSourceSelector
  | SopTraceSourceSelector
  | FrictionRollupSourceSelector
  | AnchorTelemetrySourceSelector
  | QcMetricsSelector
  | PromptSegmentsSourceSelector;

/**
 * Resolved evidence source paths (a2a only — for backward-compat helpers in validation.ts).
 * Paths are resolved inside the publisher's temporary artifact root so copied
 * evidence is included in the durable artifact bundle.
 *
 * cw adapter does NOT use this — it resolves selector → trials via provider port.
 */
export interface ResolvedSourceRefs {
  snapshotPath: string;
  attributionPath: string;
}

/**
 * Generator contract — produces verdict.md + bundle/ for the packet's domain.
 *
 * F192 Phase H 收尾 PR-2 (砚砚 R1 Q1): adapter is self-contained — receives RAW
 * `sourceRefs` (not pre-resolved) and both roots (live + artifact staging). Each adapter:
 * - a2a: validate basenames, resolve in live root, copy to artifact staging, call generateA2aLiveVerdict
 * - capability-wakeup: validate selector, provider.resolve(selector) → trials, call generateCapabilityWakeupLiveVerdict
 *
 * Handler stays domain-agnostic (砚砚 R1 P1: route layer dispatches single generator
 * via eval-hub.ts opts.verdictGenerators[domainId]).
 */
export type VerdictGenerator = (
  packet: VerdictHandoffPacket,
  sourceRefs: VerdictSourceRefs,
  deps: GeneratorDeps,
) => Promise<{
  verdictPath: string;
  bundleDir: string;
  /**
   * Legacy compatibility field for extra paths written under the artifact staging
   * root (for example raw inputs referenced by provenance.json). The local artifact
   * publisher commits the entire staging root atomically, so callers do not need to
   * perform any Git operation. Omit/empty when everything lives under `bundleDir`.
   */
  extraStagedPaths?: string[];
  /** Optional live side effect that may run only after durable artifact publication succeeds. */
  afterPublish?: () => void | Promise<void>;
}>;

export interface GeneratorDeps {
  /** Temporary artifact root where the generator writes verdict.md + bundle. */
  harnessFeedbackRoot: string;
  /** LIVE checkout's docs/harness-feedback — a2a needs this to read raw snapshot/attribution YAML
   *  that are gitignored from origin/main (砚砚 R17 P1 cloud). cw doesn't use it. */
  liveHarnessFeedbackRoot: string;
  /** Server-trusted callback principal userId for owner-scoped evidence reads. */
  ownerUserId?: string;
  /** Runtime-configured task-outcome DB path (trusted server config, may be absolute). */
  taskOutcomeDbPath?: string;
  /** Runtime-configured event-memory DB path (trusted server config, may be absolute). */
  eventMemoryDbPath?: string;
}

export interface PublishVerdictDeps {
  harnessFeedbackRoot: string;
  /** F257 / F192 sunset: durable artifact publisher (default throws). */
  artifactPublisher?: ArtifactPublisher;
  /** AC-H2: domain-specific generator (default throws — route-layer must inject per-domain). */
  generator?: VerdictGenerator;
  /** 砚砚 R6 P1: Redis client for OQ-20 eval-cat overrides (symmetric with trigger-now). */
  redis?: Redis;
  /** Runtime-configured task-outcome DB path (trusted server config, may be absolute). */
  taskOutcomeDbPath?: string;
  /** Runtime-configured event-memory DB path (trusted server config, may be absolute). */
  eventMemoryDbPath?: string;
}

export interface PublishVerdictInput {
  packet: unknown; // user-supplied — strict validation via VerdictHandoffPacket
  domain: string; // must match packet.domainId
  /** AC-H3: catId derived from callback auth at MCP server layer. */
  catId: string;
  /** Server-trusted callback principal userId (not user-supplied). */
  ownerUserId?: string;
  /** 砚砚 R1 P1 #2: explicit evidence refs (sanitized YAML basenames OR replayable selector). Tool NEVER fabricates. */
  sourceRefs: VerdictSourceRefs;
}

export interface PublishVerdictSuccess {
  ok: true;
  verdictPath: string;
  bundleDir: string;
  artifactId: string;
  artifactUrl: string;
}

export interface HandlerError {
  status: number;
  error: string;
  detail?: string;
}
