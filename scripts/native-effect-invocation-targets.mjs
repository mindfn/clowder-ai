import { executedInvocations } from './lib/shell-invocation.mjs';
import { constrainedGhApiOperation, constrainedGhPullRequestOperation } from './native-effect-github-classifier.mjs';
import { withoutInterpreterSource } from './native-effect-interpreter-source.mjs';
import { proveProgramSelection } from './native-effect-program-selection.mjs';

const quote = (word) => `'${word.replaceAll("'", "'\\''")}'`;

const LOAD_ENV = [
  'NODE_OPTIONS',
  'NODE_PATH',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
  'BASH_ENV',
  'ENV',
];

/** New read semantics retain program identity and the original environment boundary. */
export function observedReadProgram(command, cwd, namespaceStable) {
  const call = completeDirectInvocation(executedInvocations(command, { cwd }));
  if (!call || !['diff', 'gh'].includes(call.name)) return {};
  if (call.name === 'gh' && !call.program.includes('/')) return {};
  // A prior environment/namespace mutation invalidates this host observation.
  // Inherited code loaders remain code even without an inline assignment.
  if (!namespaceStable || LOAD_ENV.some((name) => process.env[name])) return { unproved: true };
  // The launcher owns gh lookup. An inline assignment cannot select its Node or delegate.
  if (call.name === 'gh' && call.environment.length) return { unproved: true };
  if (call.environment.some((word) => !/^(?:PATH|CAT_CAFE_REAL_GH_PATH)=/.test(word))) return { unproved: true };
  const selection = proveProgramSelection(call);
  if (call.name === 'diff') {
    return {
      unproved:
        selection?.kind !== 'ordinary_executable' ||
        !['/usr/bin/diff', '/bin/diff'].includes(selection.executable.realpath),
    };
  }
  if (call.redirections?.length || selection?.kind !== 'repository_gh_wrapper') return { unproved: true };
  const named = ['gh', ...call.programOperands].map(quote).join(' ');
  const operation = constrainedGhApiOperation(named) ?? constrainedGhPullRequestOperation(named);
  return operation?.effect === 'read' ? { command: named, unproved: false } : {};
}

/** Project targets from the original shared reader; retain its code/argv evidence.
 * PATH chooses an executable; observation must prove its selection before it can
 * leave target text. The same observed program may establish a bounded inline
 * application's data channel even when PATH is inherited. Neither observation
 * nor projection grants execution authority.
 */
export function invocationTargetView(command, cwd) {
  const reader = executedInvocations(command, { cwd });
  const call = completeDirectInvocation(reader);
  if (!call) return null;
  const hasPath = call.environment?.some((word) => word.startsWith('PATH='));
  const operands = ['echo', 'printf'].includes(call.name) ? [] : call.programOperands;
  // Empty argv slots are real slots: dropping an empty -e value could promote
  // a later loader option into the code slot and erase its actual path.
  const programText = [call.program, ...operands].map(quote).join(' ');
  const projected = withoutInterpreterSource(programText, { opaqueArguments: true });
  if (!hasPath && projected === withoutInterpreterSource(programText)) return null;
  const programSelection = proveProgramSelection(call);
  if (!programSelection) return null;
  const configuration = call.environment.filter((word) => !word.startsWith('PATH='));
  const targets = [projected, ...configuration.map(quote)];
  for (const redirect of call.redirections ?? []) {
    if (!redirect.operand?.literal) return null;
    targets.push(`${redirect.operator}${quote(redirect.operand.value)}`);
  }
  return { text: targets.join(' '), call, programSelection };
}

function completeDirectInvocation(reader) {
  const calls = reader.directInvocations;
  if (!reader.complete || calls?.length !== 1) return null;
  const call = calls[0];
  if (!call.argvComplete || !call.coordinateKnown || call.delegated || call.generatedCode) return null;
  if (typeof call.program !== 'string' || !call.program) return null;
  // Generated argv and code remain on the conservative original-source path.
  if (call.argumentEvidence?.length || call.unprovedCodeEvidence?.length) return null;
  return call;
}
