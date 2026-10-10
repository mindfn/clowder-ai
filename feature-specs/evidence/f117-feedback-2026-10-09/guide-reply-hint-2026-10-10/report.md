# Active-member guide-reply hint

Sources: operator thread_msr51149hym0i79f messages 0001791603468042-000039-7fa315e0 and 0001791603555843-000044-aa0d9c06. The earlier residual cleanup is commit 25ec5e7f5812012332f113d21be7a120bb1c1d48, based on published 7c87b0f8. Both changes share the original feature checkout and receive one final local review.

## Behavior

Reuse the existing thread-scoped activeCatIds projection, concrete-client messageDeliveryCapabilities.guideReply, and shared display-name formatter. The empty-input hint names only running members with guideReply=true. Missing capability does not count as support; inactive guide-capable members are omitted. When none qualify, use the ordinary/custom placeholder. Private whisper input retains its own placeholder. The existing 排队等待 sending preference (internal enum next_work) also retains the ordinary placeholder, because this mode will not append on plain Send. Operator 0001791603845245-000070-788959e8 corrects the old 下一件工作 terminology; this means a sending mode, not a separate task concept. No routing, API, ability declaration, read state or sending preference changes.

Requested example: A/B/C are running, only A/C support guide-reply. Render: 执行发生了偏离？A/C支持引导回复，可继续输入直接发送消息而不中断当前回复. Existing textarea resize now also follows the hint, so an asynchronously loaded long hint is not clipped on mobile. No new status row or control.

## Verification

Three existing Web test files, 28/28: chat-input-message-disposition, chat-input-v2-stop, chat-input-b10-whisper-active. The existing disposition journey now covers mixed capability, inactive capable member and missing/unsupported capability. Stop/send controls are preserved. Biome error-level check and git diff --check pass.

Author browser proof: isolated headless Chromium renders the real worktree ChatInput, actual chat store, real preference hook and compiled worktree stylesheet. Fixture-only member data, router and fetch are inert; no runtime network, Redis, provider request or config change. Build/entry scripts included for traceability; paths identify the author checkout. Desktop mixed/none/idle/next-work and mobile mixed receipt assertions passed. Screenshots mixed.png, none-1440.png, mixed-390.png were inspected; the mobile follow-up specifically rechecks complete text after resize dependency update. No full shell experience or soak claim.

This is a frontend tip optimization plus the already recorded orphan cleanup. The content-modification target-service availability check is explained in the residual report and remains unchanged. Independent review, publication and runtime uptake are pending at this author cut.
