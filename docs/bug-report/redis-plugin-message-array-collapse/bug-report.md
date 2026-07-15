# Redis plugin message array collapse

## Bug diagnosis capsule

| Field | Evidence |
| --- | --- |
| Reporter | K-1 fresh-context review, reproduced by 砚砚 on 2026-07-15. |
| Symptom | A Redis `updateExtra` that merges a plugin payload with another top-level field returns a message with `extra.pluginMessage === undefined`. The payload should survive byte-for-byte, including empty arrays. |
| Evidence | `plugin-messaging-redis-stores.test.js` fails at `concurrent partial updates preserve disjoint top-level extra fields`: expected `appendOps: []`, actual plugin payload `undefined`. The isolated Redis runner reproduces it consistently. |
| Root cause | The branch-local `EXTRA_MERGE_LUA` decodes and re-encodes the whole `extra` JSON object with Redis Lua `cjson`. An empty JSON array becomes an empty Lua table and is encoded as `{}`. The fail-closed parser then rejects `appendOps`, so it drops the complete plugin payload. |
| Diagnostic strategy | Trace `appendOps` from `serializeExtra` through the Lua merge and `safeParseExtra`; compare with the pre-branch client-side merge and with independent Redis hash fields used by the same message record. |
| Timeout strategy | If an independent field does not make the existing RED green in one implementation pass, stop and inspect the raw hash plus parser output instead of stacking fallbacks. |
| Warning strategy | Any second representation that can overwrite a newer plugin revision, or any hard-delete path that leaves the independent payload behind, invalidates the design. Three failed fixes require an architecture review. |
| User-visible correction | Plugin messages keep their canonical payload and remain appendable after Redis round-trips; host metadata updates no longer rewrite plugin payload JSON. |
| Acceptance | Existing isolated Redis RED turns green; parser compatibility, append service, hard-delete, build, targeted non-Redis tests, and full Redis failing-set comparison pass. |

## Fix choice

Store the canonical plugin payload in its own message-hash field and update it through a dedicated store method. Keep ordinary host `extra` metadata in its existing JSON field. This removes the cross-domain read-modify-write collision and avoids all Lua JSON re-encoding for plugin arrays while retaining legacy embedded-payload reads.

Rejected alternatives:

- Configure Redis Lua `cjson` globally: capability and behavior vary by Redis build, and nested empty-array intent is already lost after decode.
- String-patch top-level JSON in Lua: reimplementing a JSON parser is unsafe and harder to verify than using a separate hash field.
- Keep client-side read/merge/write for both domains: concurrent host metadata and plugin appends can still overwrite each other.

## Verification record

The final command evidence is recorded in the F258 quality-gate report when the branch is review-ready.
