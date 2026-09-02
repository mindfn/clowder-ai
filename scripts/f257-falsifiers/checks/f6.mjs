import { combine, fail, pass, unbound } from '../lib/report.mjs';

export const CONSOLE_ENTRY = '/settings?s=rules → 生命周期与注入 → 回合构建 → <segment> 📊';

export async function checkF6({ api, segmentId }) {
  const { status, body } = await api.getJson(`/api/segment-evaluation/${encodeURIComponent(segmentId)}`);
  if (status !== 200 || !body || typeof body !== 'object') {
    return fail('F-6', `segment-evaluation read model returned ${status} for ${segmentId}`, { status, body });
  }
  const tracing = body.tracing;
  if (!tracing || typeof tracing !== 'object') {
    return fail('F-6', 'read model has no tracing view', { keys: Object.keys(body) });
  }
  const parts = [];
  parts.push(
    'unclassifiedEpisodeCount' in tracing
      ? fail('F-6', '"待分类" residue: tracing.unclassifiedEpisodeCount still projected (TC-12)')
      : pass('F-6', 'no 待分类 projection'),
  );
  const perObjective = tracing.trigger?.perObjective;
  if (!Array.isArray(perObjective) || perObjective.length === 0) {
    parts.push(fail('F-6', 'trigger.perObjective missing or empty'));
  } else {
    parts.push(
      unbound('F-6', 'two groups + cadence lane + cycle start: S4 projection field names not bound', {
        sample: perObjective[0],
      }),
    );
  }
  parts.push(unbound('F-6', `browser pass pending (Playwright, manual): ${CONSOLE_ENTRY}`));
  return combine('F-6', parts);
}
