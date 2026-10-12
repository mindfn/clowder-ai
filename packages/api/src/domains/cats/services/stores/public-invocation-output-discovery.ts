import { snapshotPluginProtocolData } from '../../../plugin/carrier/plugin-protocol-data.js';

export interface PublicOutputLookupInput {
  readonly userId: string;
  readonly threadId: string;
  readonly sourceMessageId: string;
  readonly childInvocationId: string;
}
export type PublicOutputLookupResult =
  | { kind: 'missing' }
  | { kind: 'unique'; outputMessageId: string }
  | { kind: 'conflict' };

export function capturePublicOutputLookup(input: PublicOutputLookupInput): PublicOutputLookupInput {
  const row = snapshotPluginProtocolData(input) as PublicOutputLookupInput;
  if (
    !row ||
    Object.keys(row).length !== 4 ||
    !['userId', 'threadId', 'sourceMessageId', 'childInvocationId'].every(
      (key) =>
        typeof row[key as keyof PublicOutputLookupInput] === 'string' &&
        row[key as keyof PublicOutputLookupInput].length > 0,
    )
  )
    throw new TypeError('Invalid public output lookup identity');
  return row;
}

/** Hex encodes UTF-8 coordinates without delimiter or prefix collisions. Every member has score zero. */
export function publicOutputLookupPrefixes(input: PublicOutputLookupInput): readonly [string, string] {
  const hex = (value: string) => Buffer.from(value, 'utf8').toString('hex');
  return [
    `s:${hex(input.userId)}:${hex(input.sourceMessageId)}:`,
    `c:${hex(input.userId)}:${hex(input.childInvocationId)}:`,
  ];
}

/** At most two members per dimension suffice to prove uniqueness or a conflict. No hydration or repair. */
export function resolvePublicOutputLookup(input: PublicOutputLookupInput, raw: unknown): PublicOutputLookupResult {
  try {
    const pairs = snapshotPluginProtocolData(raw);
    if (!Array.isArray(pairs) || pairs.length !== 2) return { kind: 'conflict' };
    const prefixes = publicOutputLookupPrefixes(input);
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const members = pairs[i];
      if (!Array.isArray(members) || members.length > 1) return { kind: 'conflict' };
      if (members.length === 0) continue;
      const member = members[0];
      const prefix = prefixes[i]!;
      if (typeof member !== 'string' || !member.startsWith(prefix)) return { kind: 'conflict' };
      const id = member.slice(prefix.length);
      if (!/^\d{16}-\d{6,}-[0-9a-f]{8}$/.test(id)) return { kind: 'conflict' };
      ids.push(id);
    }
    if (ids.length === 0) return { kind: 'missing' };
    return ids.length === 2 && ids[0] === ids[1] ? { kind: 'unique', outputMessageId: ids[0]! } : { kind: 'conflict' };
  } catch {
    return { kind: 'conflict' };
  }
}
