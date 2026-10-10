# task300 whisper recipient boundary successor

Review source 0001791625683676-000303-0bc4169c remains changes_requested for c35477172a997fb0db3601b63170cd3b0e67df6f / ffa47a3f6ba43d7f61958f105220d7a6a2ff50c1. This packet is its local unpublished successor.

## Cause and correction

Common send classified typed carriers as exact, but omitted the existing whisper visibility and whisperTo boundary. Consequently ordinary public fallback could replace a whisper recipient. Queue fresh-turn target resolution also independently reapplied conversation fallback after admission, so fixing send alone would not protect a recipient becoming unavailable while queued. The previous review coverage did not include these private-recipient cases; this is an implementation/verification gap, not a new product feature.

- send rejects a whisper target set outside whisperTo (or empty) and uses its existing exact-target resolution for authorized whisper recipients. Public fallback remains unchanged; no new source-specific policy, ledger schema or scheduler is added.
- Both automatic drain and manual processNext share conversation target resolution constrained by each persisted source's existing canViewMessage predicate. An unauthorized fallback is removed; existing invalid_explicit_target settlement handles a head without a permitted receiver, without transmitting its body to another member.
- Native Append checks the actual source messages against each exact receiving run before lifecycle exposure/client dispatch; a misrouted legacy row is restored and rejected. The final fresh-turn source-custody fence applies the same existing visibility predicate, including claimed batch sources.
- Existing user/owner/exact parent/Stop/Queue ordering, public fallback, same-ID policy/target replay and A2A exact failure paths remain. Revealed messages retain the existing canViewMessage semantics. No runtime config/data/process or published PR changed.

## Author evidence

Original reviewer script SHA 52a0c9da0171443afea60df616006b0ae3f4f45674450b5dd783bdc0ff6b4974, unchanged: personally reproduced 1 red + 2 green on c354; unchanged rerun after correction 3/3. The owned Fastify/QueueProcessor test captures the execution boundary, not a real provider invocation.

19 API files / 26 suites: 364/364. Includes 7 new meaningful boundary cases: late recipient loss via drain/processNext; forbidden common-send targets plus permitted same-ID retries; authorized automatic Append; automatic/manual rejection of legacy misrouted Append; Redis concurrent recipient replay/reload and changed-recipient rejection. Public fallback/A2A and existing FIFO/ACK regressions remain in this command. Counts overlap with focused 81/81 and original reproducer; do not add as unique totals.

Four consistently compiled Live/persisted-delivery copies: 40/40; restored verbatim from the prior packet, assertions unchanged, removed after rerun. TypeScript exit0; five-file Biome error-level check and diff-check pass. Isolated owned Redis fixtures preserve AOF/RDB and source TTL=-1. No true provider, full gate, remote CI, operator acceptance/soak, publication, merge or restart is claimed.

## Continued scope

The preceding ordinary fallback, target/policy replay and A2A boundary evidence remains historical and is not retroactively approved. Final review must bind this successor. #1398/#222 publication still waits for independent review; upstream still excludes fork plugin/CI paths.
