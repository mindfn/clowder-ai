import { unbound } from '../lib/report.mjs';

// What each not-yet-bindable falsifier waits for (which slice lands the observation surface).
export const BIND_NOTES = Object.freeze({
  'F-1':
    'S2: CycleRecord read face (evalStatus=written, evaluation.metrics[]) + Objective thread assignment / write-back tool calls',
  'F-4':
    'S1/S2: CycleRecord history (next cycleStart == previous cycleEnd) + next assignment windows[] ≥ 2 with priorSkipReasons',
  'F-5':
    'S3: governance assignment ≤ 5 min after write-back, CycleRecord.governance, F276 card approve/skip/reject, registry rescan',
  'F-7': 'S1: CycleRecord read face + registry-driven thresholds/min interval + first-cycle start',
});

export function checkUnbound(id) {
  return unbound(id, `surface not bound yet — ${BIND_NOTES[id] ?? 'no bind note'}`);
}
