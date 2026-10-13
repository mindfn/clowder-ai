import { describe, expect, it } from 'vitest';
import { parseUnifiedAttentionRead } from '../parse-unified-attention';

const source = (overrides: Record<string, unknown> = {}) => ({
  status: 'available',
  startedAt: 1,
  observedAt: 2,
  coverage: 'all_registered_F246_producers',
  exhaustiveness: 'complete',
  ...overrides,
});

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    status: 'available',
    scope: 'owner_all_projects',
    identity: { ownerUserId: 'owner-1' },
    observedAt: 3,
    sources: { approvals: source(), needsMe: source({ coverage: 'current_linked_F310_five_producers' }) },
    readWindow: { startedAt: 1, endedAt: 3, consistency: 'independent_source_reads' },
    consistency: { state: 'verified', reasons: [] },
    items: [
      {
        decisionRef: 'approval:F309:p1',
        kind: 'approval',
        summary: '一件',
        linkedNeedsMe: [],
        approval: { proposalId: 'p1', sourceFeatureId: 'F309' },
      },
    ],
    totalCount: 1,
    page: { offset: 0, limit: 20, scope: 'known_rows', hasMore: false },
    ...overrides,
  };
}

describe('parseUnifiedAttentionRead — a body is a read only if it is a version-1 read', () => {
  it('accepts a well-formed read and keeps extra fields the producer may add', () => {
    const parsed = parseUnifiedAttentionRead(body({ approvalCount: 1, futureField: true }));
    expect(parsed?.identity.ownerUserId).toBe('owner-1');
    expect(parsed?.totalCount).toBe(1);
    expect(parsed?.items).toHaveLength(1);
  });

  it('accepts a read with no totalCount and with no approval on an item', () => {
    const parsed = parseUnifiedAttentionRead(
      body({
        totalCount: undefined,
        items: [{ decisionRef: 'f306:s:1', kind: 'judgment', summary: 's', linkedNeedsMe: [] }],
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.totalCount).toBeUndefined();
  });

  it('accepts a canonical pending-question coordinate', () => {
    const parsed = parseUnifiedAttentionRead(
      body({
        items: [
          {
            decisionRef: 'f306.runtime_interaction:choice-1',
            kind: 'judgment',
            summary: '在哪里验收？',
            linkedNeedsMe: [],
            choiceRequest: {
              interactionId: 'choice-1',
              revision: 20,
              requesterCatId: 'codex-sol',
              createdAt: 10,
              title: '选择环境',
              questions: [{ id: 'env', header: '环境', question: '在哪里验收？' }],
              cardRef: { threadId: 'thread-1', messageId: 'message-1', blockId: 'card-1' },
            },
          },
        ],
      }),
    );
    expect(parsed?.items[0]?.choiceRequest?.cardRef.blockId).toBe('card-1');
  });

  it.each([
    ['not an object', 'nope'],
    ['null', null],
    ['an array', []],
    ['another version', body({ version: 2 })],
    ['an unknown overall status', body({ status: 'ok' })],
    ['a missing owner identity', body({ identity: {} })],
    ['a blank owner identity', body({ identity: { ownerUserId: ' ' } })],
    ['a different scope', body({ scope: 'one_project' })],
    ['a missing source', body({ sources: { approvals: source() } })],
    ['an unknown source status', body({ sources: { approvals: source({ status: 'fine' }), needsMe: source() } })],
    [
      'an unknown exhaustiveness',
      body({ sources: { approvals: source({ exhaustiveness: 'all' }), needsMe: source() } }),
    ],
    ['an unknown consistency', body({ consistency: { state: 'maybe', reasons: [] } })],
    ['items that are not an array', body({ items: {} })],
    ['an item with no decisionRef', body({ items: [{ kind: 'approval', summary: 's', linkedNeedsMe: [] }] })],
    [
      'an item of an unknown kind',
      body({ items: [{ decisionRef: 'x', kind: 'chat', summary: 's', linkedNeedsMe: [] }] }),
    ],
    [
      'an item whose linkedNeedsMe is not an array',
      body({ items: [{ decisionRef: 'x', kind: 'repair', summary: 's' }] }),
    ],
    [
      'an approval with no proposalId',
      body({ items: [{ decisionRef: 'x', kind: 'approval', summary: 's', linkedNeedsMe: [], approval: {} }] }),
    ],
    ['a negative attentionCount', body({ attentionCount: -1 })],
    [
      'a malformed choice-card coordinate',
      body({
        items: [
          {
            decisionRef: 'f306.runtime_interaction:choice-1',
            kind: 'judgment',
            summary: 's',
            linkedNeedsMe: [],
            choiceRequest: {
              interactionId: 'choice-1',
              revision: 20,
              requesterCatId: 'codex-sol',
              createdAt: 10,
              title: '选择环境',
              questions: [{ id: 'env', header: '环境', question: '在哪里验收？' }],
              cardRef: { threadId: 'thread-1', messageId: 'message-1', blockId: ' ' },
            },
          },
        ],
      }),
    ],
    [
      'a malformed structured-choice source',
      body({
        sources: {
          approvals: source(),
          needsMe: source({ coverage: 'current_linked_F310_five_producers' }),
          structuredChoices: { status: 'available' },
        },
      }),
    ],
    ['malformed mention counts', body({ mentionCounts: { today: 0, week: 0, earlier: '558', handled: 0 } })],
    ['an unknown mention filter', body({ mentionPeriod: 'urgent' })],
    ['a negative totalCount', body({ totalCount: -1 })],
    ['a fractional totalCount', body({ totalCount: 1.5 })],
    ['a missing page', body({ page: undefined })],
  ])('rejects %s, so it can never be read as an empty success', (_label, input) => {
    expect(parseUnifiedAttentionRead(input)).toBeNull();
  });
});
