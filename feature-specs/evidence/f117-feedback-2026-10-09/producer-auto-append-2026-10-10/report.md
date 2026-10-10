# Producer auto-Append and concise guide hint

Base: 8114bfbfe2a150dae066faa6d9158810831dd775 (reviewed 7b78bfca tree continuity; CI plugin increment excluded).

## Operator source

Thread thread_msr51149hym0i79f, operator 0001791615237534-000021-70e83b0d: GitHub Wait #221 remained queued while #220 was processing. Source 0001791615118086-000016-7e4d0d42 was durably delivered and later ran as response 0001791615160818-000019-4aaa36c5. Read-only exact message evidence shows an external github-wait source and settled dispatch, not a dropped notification. No replay of either historical notice.

Operator 0001791615425169-000031-e7cbb863 requested a shorter, clearer guide hint. New copy: “想调整方向？可直接给{names}发消息，引导回复。” Operator 0001791615799345-000044-d4fd8b94 supplied the shorter formulation; no duplicated “不中断” instruction. Active-thread membership and guideReply capability selection stay unchanged.

## Root cause and change

index.ts wires PersistedQueueDelivery.progress to QueueProcessor.progressOwnedCarrier. Its busy-target branch returned owned_deferred_busy before invoking the shared tryAutoAppendExactEntry used by user and A2A ingress. Removing source restrictions within Append did not connect this producer path. This is distinct from the intended merged terminal notification and from the GitHub CI collector fix.

Busy producer progress now attempts existing exact Append. Successful admission returns already_processing for the current response. Unsupported targets, private inputs, pinned continuations, foreign owners, stopped automatic processing, and mismatched bound parents retain their existing Queue behavior. No new source gate, queue identity, dedup cache, notification suppression or provider retry mechanism.

## Verification

- Before production change: actual PersistedQueueDelivery + QueueProcessor + in-memory MessageStore/Queue/InvocationTracker fixture, three producer cases failed (owned_deferred_busy rather than admission); eight other checks passed.
- After change: five API files, 101/101. Includes GitHub Wait lifecycle, Append projection/admission, queue processing and A2A ingress. Nine added cases cover three producers, same-source replay, distinct source/same text, system scheduled sender, and six negative boundaries.
- Persisted producer delivery/recovery: 14/14; no production data, network or provider used.
- Existing front-end hint suite: 8/8, no send/stop policy changes.
- API tsc compilation, diff check and scoped Biome check. Biome has pre-existing warning diagnostics; no unsafe fixes applied.
- During author verification a premature pre-build run used stale dist and remained red; a subsequent test assertion incorrectly expected a retired row to remain in the volatile fixture. Both logs are retained separately. The final green assertions verify row retirement and precise response/source identity.
- Upstream HEAD 8114bfb has 16 successful checks and one planned skip; this is base CI, not CI for this unpublished increment.

Runtime/configuration/storage/tracking data unchanged. Independent review and publication pending. Runtime experience and soak remain operator-owned.
