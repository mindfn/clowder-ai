/**
 * F257 修复清单 #3 — List Objectives Tool
 * MCP 工具: 只读发现 report_harness_signal 可用的 objectiveId，取代"三次上报三次考古"。
 */

import type { ToolResult } from './file-tools.js';
import { errorResult, successResult } from './file-tools.js';

const API_URL = process.env.CAT_CAFE_API_URL ?? 'http://localhost:3004';

interface ObjectiveDefinition {
  id: string;
  statement: string;
}

export async function handleListObjectives(): Promise<ToolResult> {
  const url = `${API_URL}/api/callbacks/objectives`;

  try {
    const response = await fetch(url);

    if (!response.ok) {
      const text = await response.text();
      return errorResult(`Failed to fetch objectives (${response.status}): ${text}`);
    }

    const data = (await response.json()) as { objectives?: ObjectiveDefinition[] };
    const objectives = data.objectives ?? [];
    if (objectives.length === 0) {
      // API fail-closes (503) on unreadable/malformed/invalid registry — a 200 with
      // an empty list is therefore a genuinely empty (but valid) catalog, not a
      // masked failure (2a R1 P1-2).
      return successResult('No objectives registered yet.');
    }
    const lines = objectives.map((o) => `- ${o.id} — ${o.statement}`);
    return successResult(
      `Valid objectiveIds for cat_cafe_report_harness_signal (pick one; do not invent):\n${lines.join('\n')}`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(`List objectives request failed: ${message}`);
  }
}

export const listObjectivesInputSchema = {};

export const listObjectivesTools = [
  {
    name: 'cat_cafe_list_objectives',
    description:
      'F257: list the registered objectives (id + statement) that cat_cafe_report_harness_signal accepts as objectiveId. ' +
      'Call this BEFORE report_harness_signal to pick a valid objectiveId instead of guessing — no more archaeology. ' +
      'Read-only; the set grows as objectives are canonized.',
    inputSchema: listObjectivesInputSchema,
    handler: handleListObjectives,
  },
] as const;
