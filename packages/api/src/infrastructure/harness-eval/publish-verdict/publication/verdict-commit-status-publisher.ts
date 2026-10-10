import type { VerdictCommitStatus } from '../types.js';

export const EVAL_METRIC_GLOSSARY_CHECK_NAME = 'Eval Metric Glossary Coverage';
const EVIDENCE_CONTRACT_SUCCESS_DESCRIPTION = 'Candidate glossary, measurement, and publication contracts passed';

export function verdictEvidenceContractSuccessStatuses(): VerdictCommitStatus[] {
  return [
    {
      context: EVAL_METRIC_GLOSSARY_CHECK_NAME,
      state: 'success',
      description: EVIDENCE_CONTRACT_SUCCESS_DESCRIPTION,
    },
  ];
}

export interface PublishVerdictCommitStatusesInput {
  repoFullName: string;
  headSha: string;
  statuses: VerdictCommitStatus[];
}
