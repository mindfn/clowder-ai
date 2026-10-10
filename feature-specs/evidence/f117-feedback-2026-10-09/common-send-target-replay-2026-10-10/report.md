# task300 common send target and replay successor

Parent: e8d668dc72540c577ccb579372502aec4d8b34eb / e1dcb3d2b30e14f0d33c8283b8b839c783ff7688. Review source 0001791623242710-000235-4f9c55fc remains changes_requested; this is its un-published successor, not a retroactive approval.

## Contract corrections

Operator239/252: only catalog mention patterns select a member; unmatched @ stays prose. Operator248 supersedes the original P1 expectation to retain an unavailable opus: ordinary public work uses the existing available conversation fallback, preserving original prose and actual receiver identity. Exact private/action/Collective/wait/cloud/Live/failure-return authority is not converted into ordinary fallback.

## Production delta

- Catalog identity validation no longer requires a registered service. Shared AgentRouter.resolveSendTargets parses missing explicit selection and uses existing conversation fallback; index injects that one resolver into send. No runtime availability advisory/preflight, source whitelist, semantic mention classifier or new delivery state is introduced.
- Unknown-mention warning helpers and their dead warning filtering are deleted. Ordinary messages no longer freeze fallback or replay policy in messages.ts. Live retains its exact session receipt check. Participants use committed actual targets; a detached target array avoids mutating authored mentions after commit.
- Shared send owns the winning Queue target/policy snapshot. Memory and Redis reuse the existing atomic admission; replay compares immutable message sender/body/mentions/media/visibility/reply/source and Queue execution identity. One optional payload.requestedTargetCats records caller selection independently of resolved/pending recipients, preventing a changed explicit selection from masquerading as fallback replay. Existing rows without this field remain readable/replayable.
- PersistedQueueDelivery no longer resolves fallback or snapshots live-row replay targets itself. Retired-carrier recovery remains because it must not resurrect completed work.
- With no available fallback, public user and message_wake sources still persist and use existing delivery_failure terminalization. Private work still needs an exact recipient; direct raw wake admission retains its strict contract. An owned A2A no-fallback red exposed the old exact-target assertion; its successor now closes with no_available_target.

## Verification

- API: 17 files, 22 suites, **290/290**, including new target/replay tests, owned Unix Redis concurrency/reload (2 cases), actual ingress policy, AgentRouter, atomic Message/Queue, FIFO/drain, failure returns, wait owner, connector, callback and cloud retry.
- Four consistently compiled Live/persisted-delivery test copies: **40/40**. Import-only substitutions ../src→../dist and .ts→.js; assertions unchanged. Verbatim copies archived; source/dist mixing and missing TS loader failures retained separately, not claimed as production failures or greens.
- Adapted independent reproducer: **4/4**. Original red script/log preserved. Two P1 fixtures now use the actual common AgentRouter resolver and assert codex fallback per operator248; P2 target drift and new-ID control remain. This is not an unmodified original rerun.
- TypeScript compile exit0; Biome error-level check and diff-check pass. No unsafe suggested fixes were applied. Old detached-snapshot test now compares the saved policy rather than obsolete undefined; exact-target rejection test explicitly exercises Live authority under the new ordinary fallback contract.

Redis data retained under /tmp/f117-send-policy-Oj4CyP (and earlier owned runs); portless socket, AOF/RDB, TTL=-1. No real provider, running checkout/config/data update, restart, full gate, remote CI or operator soak is claimed. #1398/#222 remain on their published heads until this successor is reviewed; fork plugin paths remain outside the upstream publication contract.
