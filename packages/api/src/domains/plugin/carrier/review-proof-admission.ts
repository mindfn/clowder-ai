import { z } from 'zod';
import type { PluginInventoryStore } from '../host-inventory/ports.js';
import {
  type HostProofActivation,
  ProcessLocalProofAdmissionSection,
  ProofAdmissionUnavailable,
} from './proof-admission-section.js';

const PURPOSE = 'review-trigger-coverage';
const entry = z
  .object({
    purpose: z.literal(PURPOSE),
    pluginId: z.string().min(1),
    instanceId: z.string().min(1),
    packageDigest: z.string().min(1),
    provenanceRef: z.string().min(1),
    issuerSourceRef: z.string().min(1),
  })
  .strict();
export const reviewProofPolicySchema = z
  .object({
    version: z.literal(1),
    revision: z.number().int().nonnegative(),
    entries: z.array(entry).max(64),
  })
  .strict();

/** No default production purpose authority. Installing a package never populates this port. */
export const EMPTY_REVIEW_PROOF_POLICY = Object.freeze({
  version: 1 as const,
  revision: 0,
  entries: Object.freeze([]),
});

const inputSchema = z
  .object({
    repoFullName: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    prNumber: z.number().int().positive(),
    triggerCommentId: z.number().int().positive(),
  })
  .strict();
const fields = { triggerCommentId: z.number().int().positive(), observedAt: z.number().finite().nonnegative() };
const observationSchema = z.discriminatedUnion('covered', [
  z.object({ covered: z.literal(true), ...fields }).strict(),
  z
    .object({
      covered: z.literal(false),
      reason: z.enum(['subject_mismatch', 'not_review_trigger', 'review_not_accepted', 'feedback_already_posted']),
      ...fields,
    })
    .strict(),
]);
export type ReviewProofInput = z.infer<typeof inputSchema>;
type Uncovered = Extract<z.infer<typeof observationSchema>, { covered: false }>;
export type PreparedReviewProof =
  | { covered: false; reason: Uncovered['reason'] }
  | { covered: true; admit<T>(mutation: () => Promise<T>): Promise<T> };
export interface ReviewProofAdmissionPort {
  prepare(inputs: readonly ReviewProofInput[]): Promise<PreparedReviewProof>;
}

export interface ReviewProofAdmissionOptions {
  readonly inventory: Pick<PluginInventoryStore, 'snapshot'>;
  readonly policy: { snapshot(): Promise<unknown> };
  /** Independent Host provenance resolver; neither manifest nor query payload supplies this fact. */
  readonly provenance: { resolve(instanceId: string, packageDigest: string): Promise<string | undefined> };
  readonly carrier: { captureProofActivation(instanceId: string): HostProofActivation };
  readonly section: ProcessLocalProofAdmissionSection;
}

/** Isolated mechanism only. No production composition instantiates this class. */
export class ReviewProofAdmission implements ReviewProofAdmissionPort {
  constructor(private readonly options: ReviewProofAdmissionOptions) {}

  private async binding() {
    const policy = reviewProofPolicySchema.parse(await this.options.policy.snapshot());
    const allowed = policy.entries[0];
    if (policy.entries.length !== 1 || !allowed) throw new ProofAdmissionUnavailable();
    const snapshot = await this.options.inventory.snapshot();
    const candidates = snapshot.instances.filter(
      (i) => i.pluginId === allowed.pluginId && i.lifecycleState === 'installed',
    );
    const instance = candidates.length === 1 ? candidates[0] : undefined;
    const pkg = snapshot.packages.find((p) => p.packageDigest === allowed.packageDigest);
    const grants = snapshot.grants.find((g) => g.pluginInstanceId === allowed.instanceId);
    if (
      !instance ||
      instance.pluginInstanceId !== allowed.instanceId ||
      instance.packageDigest !== allowed.packageDigest ||
      instance.activationState !== 'enabled' ||
      instance.configReadiness !== 'ready' ||
      pkg?.pluginId !== allowed.pluginId ||
      pkg.manifest.pluginId !== allowed.pluginId ||
      !grants ||
      (await this.options.provenance.resolve(allowed.instanceId, allowed.packageDigest)) !== allowed.provenanceRef
    ) {
      throw new ProofAdmissionUnavailable();
    }
    return {
      policy,
      instanceId: allowed.instanceId,
      digest: allowed.packageDigest,
      lifecycle: instance.lifecycleRevision,
      grants: grants.grantRevision,
    };
  }

  async prepare(rawInputs: readonly ReviewProofInput[]): Promise<PreparedReviewProof> {
    try {
      const inputs = z.array(inputSchema).min(1).max(64).parse(rawInputs);
      const epoch = this.options.section.revision();
      const binding = await this.binding();
      const activation = this.options.carrier.captureProofActivation(binding.instanceId);
      const valid = async () =>
        JSON.stringify(await this.binding()) === JSON.stringify(binding) && activation.isCurrent();
      for (const input of new Map(inputs.map((value) => [JSON.stringify(value), value])).values()) {
        if (epoch !== this.options.section.revision() || !(await valid())) throw new ProofAdmissionUnavailable();
        const result = observationSchema.parse(await activation.invoke('github.review-trigger.observe', input));
        if (result.triggerCommentId !== input.triggerCommentId) throw new ProofAdmissionUnavailable();
        if (!result.covered)
          return this.options.section.admit(epoch, valid, async () => ({
            covered: false as const,
            reason: result.reason,
          }));
      }
      let used = false;
      return {
        covered: true,
        admit: async <T>(mutation: () => Promise<T>) => {
          if (used) throw new ProofAdmissionUnavailable();
          used = true;
          return this.options.section.admit(
            epoch,
            async () => {
              try {
                return await valid();
              } catch {
                return false;
              }
            },
            mutation,
          );
        },
      };
    } catch {
      throw new ProofAdmissionUnavailable();
    }
  }
}
