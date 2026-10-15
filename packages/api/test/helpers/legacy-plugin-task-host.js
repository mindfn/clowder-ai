import { preparePluginEntrustedTask } from '../../src/domains/plugin/host-surface/plugin-task-admission.ts';
import { dispatchPluginEntrustedTask } from '../../src/domains/plugin/host-surface/plugin-task-dispatch.ts';

/** Historical protocol fixture for Queue/Registry compatibility tests, not the module Host API. */
export function legacyPluginTaskHost(deps) {
  return {
    prepareEntrusted: (value) => preparePluginEntrustedTask(deps, value),
    dispatchEntrusted: (value) => dispatchPluginEntrustedTask(deps, value),
  };
}
