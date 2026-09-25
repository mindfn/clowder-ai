/**
 * F202 C1 cross-repository gate — the one place the approved connector artifacts are pinned.
 *
 * Fourth connector batch after ④: built from plugins PR #54 at `e83c23e0e6d9` with the frozen
 * toolchain, verified in the ledger entry 「④ 后第四批 connector 制品」. The self-contained
 * archives are darwin-arm64 builds; they are published unchanged, with SHA256SUMS, as release
 * assets so a reviewer can fetch exactly these bytes. No module here imports Host code, so the
 * mandatory runner can check digests before it rebuilds the Host.
 */

export const PLUGIN_SOURCE = Object.freeze({
  repository: 'zts212653/clowder-ai-plugins',
  pullRequest: 54,
  sourceSha: 'e83c23e0e6d9091bff3af14c7da5eee749924472',
  batch: 4,
});

/** Where reviewers and the mandatory runner fetch the archives: `<owner>/<repo>@<tag>`. */
export const ARTIFACT_RELEASE = Object.freeze({
  repository: 'mindfn/clowder-ai-plugins',
  tag: 'f202-c1-connectors-batch4-e83c23e0e6d9',
});

/** The platform the self-contained archives were built for; the gate refuses to run elsewhere. */
export const ARTIFACT_PLATFORM = Object.freeze({ platform: 'darwin', arch: 'arm64' });

/** `media: false` = the package declares no media delivery (no `media.read`). */
export const RELEASES = Object.freeze(
  [
    [
      'dingtalk',
      '5cff63fa82b254ddedb2bc580299f37b37130d943a0d7c1e7c33bf5a9be65afe',
      'createDingTalkPluginModule',
      true,
    ],
    ['feishu', 'ae47aac4a22df8da060aa76f8b7f9e239e90d5090a2aecdfb66ad3fdfc041da4', 'createFeishuPluginModule', true],
    [
      'telegram',
      'b1333e4dd214d94ddf990d204c0aa6b169db430a1805e1bec672415fcfbbf17b',
      'createTelegramPluginModule',
      true,
    ],
    [
      'wecom-agent',
      '252de353fd985f6624f658b27a9fc4978d528d604d2e387737c4405905b4509c',
      'createWeComAgentPluginModule',
      true,
    ],
    [
      'wecom-bot',
      'e9ede6c5db178486624b8be40e36f5d8ecb88943ff2bb1ca315cd2eaea7fd12b',
      'createWeComBotPluginModule',
      true,
    ],
    ['weixin', 'c313802f29c6ee9622d726915f2dd2910fc299dc314f18da163a4ee67920b358', 'createWeixinPluginModule', true],
    ['xiaoyi', 'cfb9fbe3534f2dc1478c8f3d5ab370f12a3fa03ed0e036da280754df9eb0ac8d', 'createXiaoyiPluginModule', false],
  ].map(([name, sha, factory, media]) => Object.freeze({ name, sha, factory, media })),
);

/** Two cases per release plus the degraded-block case: what a complete run must execute. */
export const EXPECTED_CASES = RELEASES.length * 2 + 1;

export function archiveFileName(release) {
  return `clowder-ai-connector-${release.name}-0.1.0-alpha.0-darwin-arm64-${release.sha.slice(0, 12)}.tgz`;
}
