import type { CliDiagnostics } from '@cat-cafe/shared';
import { buildCliDiagnostics } from '../../../../../../utils/cli-diagnostics.js';
import { summarizeAgyStreamJsonTurn } from '../agy-stream-json-parser.js';

/** The requested native conversation cannot be resumed; the router must rebuild cold. */
export class AgyNativeResumeMismatchError extends Error {}

/** Startup failed before init; keep the existing safe CLI diagnostic surface intact. */
export class AgyNativeStartupError extends Error {
  constructor(
    message: string,
    readonly cliDiagnostics?: CliDiagnostics,
  ) {
    super(message);
  }
}

export function missingAgyNativeInitError(
  lines: readonly string[],
  transportError: string | null,
  cliDiagnostics: CliDiagnostics | undefined,
  debugRef: CliDiagnostics['debugRef'],
): AgyNativeStartupError {
  if (cliDiagnostics?.reasonCode) return new AgyNativeStartupError(cliDiagnostics.publicSummary, cliDiagnostics);
  const turn = summarizeAgyStreamJsonTurn(lines);
  // A provider may reject on stdout only. Generic exit diagnostics must not hide that reason.
  const diagnostics =
    turn.upstreamStatus === 'ERROR' && turn.upstreamError
      ? buildCliDiagnostics({
          rawText: turn.upstreamError,
          debugRef: cliDiagnostics?.debugRef ?? debugRef,
          stderrEmpty: false,
        })
      : cliDiagnostics;
  return new AgyNativeStartupError(
    diagnostics?.publicSummary ?? transportError ?? 'AGY native stream ended without a verified init',
    diagnostics,
  );
}
