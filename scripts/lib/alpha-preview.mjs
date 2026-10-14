import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertNamedAlphaCheckout, assertNamedAlphaNotServing } from './alpha-coordinates.mjs';
import { parseAlphaLaunchChild } from './alpha-launch-contract.mjs';
import { previewProcessRecordId } from './preview-process-record-key.mjs';

/** A new Alpha child must be fully attributed or refused; unsupported shapes cannot fall back to ordinary. */
export function namedAlphaPreviewDecision(invocation, shellCwd) {
  const { action, child, options, packageCwd, separator } = invocation;
  if (action !== 'start') return namedAlphaLifecycleDecision(invocation, shellCwd);
  if (!child.includes('--instance') && !child.includes('--ports')) return null;
  const deny = { status: 'deny' };
  if (action !== 'start' || separator < 0) return deny;
  if (options.has('--json')) return deny;
  const lifetime = options.get('--lifetime-seconds');
  if (lifetime !== undefined && (!/^[1-9]\d*$/.test(lifetime) || Number(lifetime) > 86400)) return deny;
  const requested = options.get('--cwd');
  if ((packageCwd ?? shellCwd) !== requested) return deny;
  try {
    const { coordinates } = parseAlphaLaunchChild(child, requested);
    assertNamedAlphaCheckout(coordinates);
    assertNamedAlphaNotServing(coordinates);
    if (options.get('--port') !== String(coordinates.ports.frontend)) return deny;
    return {
      status: 'allow',
      operation: {
        kind: 'alpha',
        action,
        effect: 'service_mutation',
        target: `preview://alpha${coordinates.mainRoot}:${coordinates.ports.frontend}`,
      },
    };
  } catch {
    return deny;
  }
}

/** Stored child configuration proves only the bounded lifecycle coordinate.
 * The launcher still verifies exact live ownership before stop; this reader
 * cannot prove a PID, executable, completion or cleanup from record text.
 */
function namedAlphaLifecycleDecision({ action, child, options, packageCwd, separator }, shellCwd) {
  if (!['status', 'stop'].includes(action) || separator >= 0 || child.length || options.has('--lifetime-seconds'))
    return null;
  const requested = options.get('--cwd');
  if ((packageCwd ?? shellCwd) !== requested || options.get('--port') === '3011') return null;
  const id = previewProcessRecordId(requested, Number(options.get('--port')));
  const stateDir = resolve(
    process.env.CAT_CAFE_PREVIEW_PROCESS_DIR ?? join(homedir(), '.cat-cafe', 'preview-processes'),
  );
  try {
    const record = JSON.parse(readFileSync(join(stateDir, `${id}.json`), 'utf8'));
    if (
      record.version !== 1 ||
      record.id !== id ||
      record.cwd !== requested ||
      record.port !== Number(options.get('--port')) ||
      !Array.isArray(record.command)
    )
      return null;
    const { coordinates, options: launchOptions } = parseAlphaLaunchChild(record.command, requested);
    if (!launchOptions['--instance'] || coordinates.ports.frontend !== record.port) return { status: 'deny' };
    assertNamedAlphaCheckout(coordinates);
    return {
      status: 'allow',
      operation: {
        kind: 'alpha',
        action,
        effect: action === 'status' ? 'read' : 'process_control',
        target: `preview://alpha${coordinates.mainRoot}:${coordinates.ports.frontend}`,
      },
    };
  } catch (error) {
    // Absence is an observation contract, not proof of Alpha ownership. The
    // caller may admit only its bounded read-only status grammar.
    if (action === 'status' && error.code === 'ENOENT') return { status: 'unregistered' };
    return null;
  }
}
