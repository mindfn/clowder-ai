import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { mapPublishVerdictError } from './error-mapping.js';
import type { ArtifactPublisher, ArtifactRef, PublishArtifactOpts } from './types.js';

function isNodeError(err: unknown, code: string): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === code;
}

export interface LocalArtifactPublisherDeps {
  /** Root directory where verdict artifacts are persisted. */
  artifactRoot: string;
}

function toDomainSlug(domainId: string): string {
  return domainId.replace(/:/g, '-');
}

function toArtifactUrl(domainSlug: string, artifactId: string): string {
  return `artifact://${domainSlug}/${artifactId}`;
}

/**
 * F257 / F192 sunset: durable artifact publisher that stores verdict bundles on
 * the local filesystem (under `CAT_CAFE_DATA_DIR` or a configured root), NOT in
 * the product Git repository.
 *
 * Contract:
 * - Artifacts live at `<artifactRoot>/<domainSlug>/<artifactId>/`.
 * - The directory preserves the generator layout under
 *   `docs/harness-feedback/{verdicts,bundles}/` plus replay inputs.
 * - Writes are staged to a temp directory and atomically renamed to the final
 *   path so concurrent publishers and readers never see a partial artifact.
 * - Duplicate artifact IDs are rejected (idempotent — publishing the same id
 *   twice is a client error, not an overwrite).
 * - `afterPublish` runs exactly once after the artifact is durably published.
 * - On failure, the temp directory is removed.
 *
 * The filesystem backend can later be replaced by an object store or database
 * without changing the ArtifactPublisher contract.
 */
export function createLocalArtifactPublisher(deps: LocalArtifactPublisherDeps): ArtifactPublisher {
  return {
    async publishArtifact(opts: PublishArtifactOpts): Promise<ArtifactRef> {
      const domainSlug = toDomainSlug(opts.packet.domainId);
      const artifactId = opts.packet.id;
      const finalDir = resolve(deps.artifactRoot, domainSlug, artifactId);
      const verdictPath = resolve(finalDir, 'verdict.md');
      const bundleDir = resolve(finalDir, 'bundle');

      if (existsSync(finalDir)) {
        throw new Error(
          `artifact_already_exists: artifact '${artifactId}' already exists for domain '${opts.packet.domainId}' at ${finalDir}`,
        );
      }

      mkdirSync(deps.artifactRoot, { recursive: true });
      const tempDir = mkdtempSync(resolve(deps.artifactRoot, `.staging-${domainSlug}-${artifactId}-`));
      const harnessFeedbackRoot = resolve(tempDir, 'docs', 'harness-feedback');
      mkdirSync(harnessFeedbackRoot, { recursive: true });

      let afterPublish: (() => void | Promise<void>) | undefined;
      try {
        const generated = await opts.generate(harnessFeedbackRoot);

        // Validate that the generator wrote the expected files so the atomic
        // rename does not publish an empty or misplaced artifact.
        if (!existsSync(generated.verdictPath)) {
          throw new Error(`generator did not write verdict.md at expected path: ${generated.verdictPath}`);
        }
        if (!existsSync(generated.bundleDir)) {
          throw new Error(`generator did not write bundle directory at expected path: ${generated.bundleDir}`);
        }

        afterPublish = generated.afterPublish;

        // Atomic publication: readers either see the old state (none) or the fully
        // written finalDir, never a partial write. The parent domain directory
        // is created first so rename(2) does not fail with ENOENT on the dest.
        mkdirSync(dirname(finalDir), { recursive: true });
        renameSync(tempDir, finalDir);
      } catch (err) {
        rmSync(tempDir, { recursive: true, force: true });
        // Concurrent duplicate publish: both callers passed the initial
        // existsSync check. Normalize the OS-level rename race to the same
        // contract as the upfront duplicate-ID guard.
        if (isNodeError(err, 'EEXIST') || isNodeError(err, 'ENOTEMPTY')) {
          throw new Error(
            `artifact_already_exists: artifact '${artifactId}' already exists for domain '${opts.packet.domainId}' at ${finalDir}`,
          );
        }
        throw err;
      }

      if (afterPublish) {
        try {
          await afterPublish();
        } catch (afterErr) {
          // afterPublish is part of the publication unit of work. If the
          // side-effect (e.g. task-outcome SQLite writeback) fails, roll back
          // the exposed artifact so the Hub never surfaces a verdict whose
          // downstream state is inconsistent.
          rmSync(finalDir, { recursive: true, force: true });
          const message = afterErr instanceof Error ? afterErr.message : String(afterErr);
          // Preserve typed domain errors (e.g. invalid_episode_verdict_writeback)
          // so the handler's error-mapping layer continues to return the correct
          // 4xx status instead of a generic 500 publisher_failed.
          if (mapPublishVerdictError(message)) {
            throw afterErr;
          }
          throw new Error(`artifact_publish_rollback: afterPublish failed for ${artifactId}: ${message}`);
        }
      }

      return {
        artifactId,
        domainSlug,
        verdictPath: resolve(finalDir, 'docs', 'harness-feedback', 'verdicts', `${artifactId}.md`),
        bundleDir: resolve(finalDir, 'docs', 'harness-feedback', 'bundles', artifactId),
        artifactUrl: toArtifactUrl(domainSlug, artifactId),
      };
    },
  };
}
