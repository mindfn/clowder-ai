/**
 * The install's one owner.
 *
 * Two settings name it, and they answer different questions:
 * `DEFAULT_OWNER_USER_ID` is the owner trust anchor privileged gates check, and
 * `CAT_CAFE_USER_ID` is the user whose runtime data this install owns — the id the
 * install also mints its loopback browser session under. One install has one owner,
 * so when the anchor is configured it must name that same user.
 *
 * When the two disagree, a legal-looking deployment locks its owner out
 * deterministically, and the two failures do not even look alike:
 * a loopback session is minted as `CAT_CAFE_USER_ID`, so it fails every privileged
 * gate; and with the anchor left at `default-user` while `CAT_CAFE_USER_ID` is
 * someone else, a remote session is minted as `default-user`, passes the gate, and
 * then finds the install's own F257 lifecycles in another owner's space — authorized,
 * then 404. Refusing to boot is the honest outcome: the alternative is an install
 * whose owner cannot govern it, with no error anywhere.
 */
export function resolveInstallOwnerUserId(env: NodeJS.ProcessEnv = process.env): string {
  const runtimeUserId = (env.CAT_CAFE_USER_ID ?? 'default-user').trim();
  if (!runtimeUserId) throw new Error('[api] CAT_CAFE_USER_ID must not be blank');
  const trustAnchor = env.DEFAULT_OWNER_USER_ID?.trim();
  if (trustAnchor && trustAnchor !== runtimeUserId) {
    throw new Error(
      `[api] DEFAULT_OWNER_USER_ID ("${trustAnchor}") and CAT_CAFE_USER_ID ("${runtimeUserId}") name different users, ` +
        'so this install has no single owner: privileged gates would trust one id while runtime data, browser sessions ' +
        'and F257 lifecycle spaces belong to the other. Set both to the owner, or leave DEFAULT_OWNER_USER_ID unset for ' +
        'single-user local mode.',
    );
  }
  return runtimeUserId;
}
