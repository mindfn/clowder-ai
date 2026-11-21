import { executedInvocations } from './lib/shell-invocation.mjs';
import { leadingShellControl, nativeBuiltinContext } from './lib/shell-program-tokens.mjs';
import { hereDocumentView } from './native-effect-heredoc.mjs';
import { segmentCommandText, segmentContexts } from './native-effect-segment-locations.mjs';
import { classifyShellSegment, splitShellExecutionSegmentsWithSeparators } from './native-effect-shell-classifier.mjs';
import { isLocalProgramBinding } from './native-effect-shell-expansion.mjs';
import { commandName } from './native-effect-shell-tokenizer.mjs';

export function secretShellDenial(command, cwd) {
  // Non-shell interpreter input is source, not another shell command stream.
  const host = hereDocumentView(command).judged;
  const parts = splitShellExecutionSegmentsWithSeparators(host);
  const builtinContexts = namespaceContexts(parts);
  const contexts = segmentContexts(parts, cwd, process.env, builtinContexts);
  for (const invocation of contextualInvocations(parts, contexts, builtinContexts)) {
    const reason = invocationDenial(invocation);
    if (reason) return reason;
  }
  return null;
}

function namespaceContexts(parts) {
  let stable = nativeBuiltinContext(
    !parts.some(
      (part) =>
        part.separator === '&' || ['for', 'while', 'until', 'function'].includes(leadingShellControl(part.text)),
    ),
  );
  return parts.map((part) => {
    const before = stable;
    stable &&=
      classifyShellSegment(part.text, { builtinContext: stable }) === 'read' || isLocalProgramBinding(part.text);
    return before;
  });
}

function contextualInvocations(parts, contexts, builtinContexts) {
  return parts.flatMap((part, index) => {
    if (['|', '|&'].includes(part.separator)) return [];
    let end = index;
    while (['|', '|&'].includes(parts[end + 1]?.separator)) end++;
    // Keep producer/consumer code evidence together within each pipeline.
    const pipeline = parts
      .slice(index, end + 1)
      .map((item, offset) => `${offset ? item.separator : ''} ${segmentCommandText(item.text)}`)
      .join(' ');
    const calls = contexts[index]
      .flatMap(({ directory, bindings, parameters }) =>
        executedInvocations(pipeline, {
          cwd: directory,
          bindings,
          parameters,
          builtinContext: builtinContexts[index] && index === end,
        }).pipelines.flat(),
      )
      .map((call) => ({
        ...call,
        namespaceStable: builtinContexts[index] && index === end,
        // A nested script owns its namespace; the outer pipeline cannot prove it.
        programNamespaceStable: builtinContexts[index] && call.parameterScope === 0,
      }));
    return calls;
  });
}

function invocationDenial(invocation) {
  const program = commandName(invocation.program ?? invocation.name);
  const operands = invocation.programOperands ?? invocation.operands;
  if (
    program === 'git' &&
    operands.includes('push') &&
    operands.some((arg) => arg === '--no-verify' || /core\.hooksPath/i.test(arg))
  )
    return 'secret_git_hook_bypass_blocked';
  return null;
}
