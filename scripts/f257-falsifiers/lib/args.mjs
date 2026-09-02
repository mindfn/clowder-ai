import process from 'node:process';

// Contract anchor: docs/features/assets/F257/terminal-contract-v1.md §4 (F-1~F-8).
export const ALL_CHECKS = Object.freeze(['F-1', 'F-2', 'F-3', 'F-4', 'F-5', 'F-6', 'F-7', 'F-8']);
const API_CHECKS = new Set(['F-5', 'F-6']);

const VALUE_ARGS = Object.freeze({
  '--api-url': 'apiUrl',
  '--redis-url': 'redisUrl',
  '--owner-user-id': 'ownerUserId',
  '--key-prefix': 'keyPrefix',
  '--checks': 'checksRaw',
  '--project-root': 'projectRoot',
  '--baseline': 'baselinePath',
  '--segment-id': 'segmentId',
  '--objective-id': 'objectiveId',
  '--json-out': 'jsonOutPath',
  '--browser-evidence': 'browserEvidencePath',
});

export const HELP = `Usage:
  node scripts/f257-falsifiers/f257-falsify.mjs baseline --redis-url <url> --owner-user-id <id> --baseline <file>
  node scripts/f257-falsifiers/f257-falsify.mjs verify --redis-url <url> --api-url <url> --owner-user-id <id> \\
      --baseline <file> [--checks F-2,F-3,...] [--project-root <dir>] [--segment-id D1] [--objective-id identity-truth] [--json-out <file>] [--browser-evidence <file>]

Contract: terminal-contract-v1.md §4 (F-1~F-8). Read-only: never writes to Redis or the API.
A check whose observation surface is not bound yet reports "unbound"; unbound is NOT a pass.
`;

function readValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`missing_value:${flag}`);
  return value;
}

export function resolveChecks(raw) {
  if (!raw) return [...ALL_CHECKS];
  const ids = raw
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  for (const id of ids) if (!ALL_CHECKS.includes(id)) throw new Error(`unknown_check:${id}`);
  return [...new Set(ids)];
}

function consumeArg(options, argv, index) {
  const arg = argv[index];
  if (arg === '--help' || arg === '-h') {
    options.help = true;
    return index;
  }
  if (arg === 'baseline' || arg === 'verify') {
    if (options.mode) throw new Error(`duplicate_mode:${arg}`);
    options.mode = arg;
    return index;
  }
  const key = VALUE_ARGS[arg];
  if (!key) throw new Error(`unknown_argument:${arg}`);
  options[key] = readValue(argv, index, arg);
  return index + 1;
}

function validateOptions(options) {
  if (!options.mode) throw new Error('mode_required:baseline|verify');
  if (!options.redisUrl) throw new Error('redis_url_required');
  if (!options.baselinePath) throw new Error('baseline_path_required');
  options.checks = resolveChecks(options.checksRaw);
  const wantsApi = options.mode === 'verify' && options.checks.some((id) => API_CHECKS.has(id));
  if (wantsApi && !options.apiUrl) throw new Error('api_url_required');
}

export function parseArgs(argv, env = process.env) {
  const options = {
    mode: undefined,
    apiUrl: env.F257_FALSIFY_API_URL,
    redisUrl: env.F257_FALSIFY_REDIS_URL,
    ownerUserId: env.F257_FALSIFY_OWNER_USER_ID ?? 'default-user',
    keyPrefix: env.REDIS_KEY_PREFIX ?? 'cat-cafe:',
    checksRaw: undefined,
    projectRoot: process.cwd(),
    baselinePath: undefined,
    segmentId: 'D1',
    objectiveId: 'identity-truth',
    jsonOutPath: undefined,
    browserEvidencePath: undefined,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) index = consumeArg(options, argv, index);
  if (!options.help) validateOptions(options);
  return options;
}
