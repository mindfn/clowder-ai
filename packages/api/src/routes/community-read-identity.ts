import type { ICommunityIssueStore } from '../domains/cats/services/stores/ports/CommunityIssueStore.js';
import type { ITaskStore } from '../domains/cats/services/stores/ports/TaskStore.js';
import type { ICommunityObjectStore } from '../domains/community/CommunityObjectStore.js';

export async function listCommunityIssuesForRepo(store: ICommunityIssueStore, repo: string) {
  const identity = repo.toLowerCase();
  return selectSubjectRecords(
    (await store.listAll()).filter((issue) => issue.repo.toLowerCase() === identity),
    (issue) => `issue:${issue.repo}#${issue.issueNumber}`,
  );
}

export async function listCommunityPrTasksForRepo(store: ITaskStore, repo: string) {
  const prefix = `pr:${repo.toLowerCase()}#`;
  return selectSubjectRecords(
    (await store.listByKind('pr_tracking')).filter((task) => task.subjectKey?.toLowerCase().startsWith(prefix)),
    (task) => task.subjectKey!,
  );
}

/** Canonical spelling wins; otherwise use code-unit key order, never recency or enumeration order. */
function preferredSubject(candidate: string, previous: string): boolean {
  const canonical = candidate.toLowerCase();
  if (candidate === canonical) return previous !== canonical;
  return previous !== canonical && candidate < previous;
}

function selectSubjectRecords<T>(records: T[], subject: (record: T) => string): T[] {
  const selected = new Map<string, T>();
  for (const record of records) {
    const key = subject(record),
      canonical = key.toLowerCase();
    const previous = selected.get(canonical);
    if (previous === undefined || preferredSubject(key, subject(previous))) selected.set(canonical, record);
  }
  return [...selected.values()];
}

export type CommunityObjectReader = Pick<ICommunityObjectStore, 'get' | 'listSubjectKeys'>;

/** Compare identities without replacing the exact keys passed to the existing store. */
export function communityObjectReadView(store: CommunityObjectReader): CommunityObjectReader {
  let index: Promise<Map<string, string>> | undefined;
  const keys = () => {
    index ??= store.listSubjectKeys().then((subjects) => {
      const identities = new Map<string, string>();
      // Existing canonical projection wins over an alias, matching the store's read semantics.
      for (const subject of subjects) {
        const canonical = subject.toLowerCase();
        const previous = identities.get(canonical);
        if (previous === undefined || preferredSubject(subject, previous)) identities.set(canonical, subject);
      }
      return identities;
    });
    return index;
  };
  return {
    async get(subject) {
      const key = (await keys()).get(subject.toLowerCase());
      return key === undefined ? null : store.get(key);
    },
    async listSubjectKeys() {
      return [...(await keys()).values()];
    },
  };
}
