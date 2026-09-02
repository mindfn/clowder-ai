export const STATUS = Object.freeze({ pass: 'pass', fail: 'fail', unbound: 'unbound' });

export function pass(id, summary, evidence = {}) {
  return { id, status: STATUS.pass, summary, evidence };
}
export function fail(id, summary, evidence = {}) {
  return { id, status: STATUS.fail, summary, evidence };
}
export function unbound(id, summary, evidence = {}) {
  return { id, status: STATUS.unbound, summary, evidence };
}

/** fail dominates; otherwise any unbound part keeps the whole check unbound. */
export function combine(id, parts) {
  const failed = parts.filter((part) => part.status === STATUS.fail);
  if (failed.length > 0) return fail(id, failed.map((part) => part.summary).join('; '), { parts });
  const pending = parts.filter((part) => part.status === STATUS.unbound);
  if (pending.length > 0) return unbound(id, pending.map((part) => part.summary).join('; '), { parts });
  return pass(id, parts.map((part) => part.summary).join('; '), { parts });
}

export function summarize(results) {
  const counts = { pass: 0, fail: 0, unbound: 0 };
  for (const result of results) counts[result.status] += 1;
  return counts;
}

export function renderTable(results) {
  const lines = ['| # | status | summary |', '|---|---|---|'];
  for (const result of results)
    lines.push(`| ${result.id} | ${result.status} | ${result.summary.replaceAll('|', '/')} |`);
  return lines.join('\n');
}

/** Only an all-pass run exits 0. unbound is honest, not green. */
export function exitCode(results) {
  return results.length > 0 && results.every((result) => result.status === STATUS.pass) ? 0 : 1;
}
