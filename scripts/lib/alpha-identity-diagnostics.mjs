const IDENTITY_FIELDS = ['cwd', 'ucomm', 'startedAt', 'startedAtEpochMs', 'startedAtFormat'];

/** Keep the original capture and its failure; diagnostics do not retry or grant ownership. */
export function captureAlphaIdentity(pid, capture, subject) {
  try {
    return capture(pid);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`${subject} identity unreadable (capture failed: ${detail})`, { cause });
  }
}

function known(value) {
  return typeof value === 'string' ? value.length > 0 : Number.isSafeInteger(value);
}

/** Called only after the existing ownership predicate refuses the observation. */
export function alphaIdentityRefusal({ subject, expected, current, required, mismatchMessage }) {
  const knownDifference = [expected, required].some((reference) =>
    IDENTITY_FIELDS.some(
      (field) => known(reference?.[field]) && known(current?.[field]) && reference[field] !== current[field],
    ),
  );
  const argvUnavailable = expected?.argvAvailable === false || current?.argvAvailable === false;
  const unreadable = !knownDifference && argvUnavailable;
  return Object.assign(new Error(unreadable ? `${subject} identity unreadable (argv unavailable)` : mismatchMessage), {
    code: unreadable ? 'ALPHA_IDENTITY_ARGV_UNAVAILABLE' : 'ALPHA_IDENTITY_MISMATCH',
  });
}
