import type { PluginManagerDiagnostic } from '@cat-cafe/shared';
import type { Capability } from '@clowder-ai/plugin-contract';
import { currentRuntimeErrorDetail } from '../host-inventory/runtime-failure-record.js';
import type { PluginGrantRecord, PluginInstanceRecord } from '../host-inventory/types.js';

/**
 * F202 W2-6b — what the owner is told about a refused capability. Not granted is not "the Host is
 * too old": the Host's policy may never grant it, so the owner is pointed at a compatible plugin
 * version or its maintainer, and never at a capability table they cannot (and need not) edit.
 */
export function capabilityNotGrantedMessage(capability: Capability, declared: boolean): string {
  return declared
    ? `This plugin version uses ${capability}, which the current Host policy does not grant it. ` +
        'Check for a plugin version compatible with this Host, or contact the plugin maintainer.'
    : `This plugin version uses ${capability} without declaring it, which is a defect in the plugin. ` +
        'Contact the plugin maintainer.';
}

/** The owner diagnostic for the instance's last runtime failure, if it has one. */
export function pluginRuntimeDiagnostic(
  instance: PluginInstanceRecord | undefined,
  grant: Pick<PluginGrantRecord, 'requestedCapabilities'> | undefined,
): PluginManagerDiagnostic | undefined {
  const error = instance?.lastRuntimeError;
  if (!instance || !error) return undefined;
  const detail = currentRuntimeErrorDetail(instance);
  if (detail === undefined) {
    return {
      code: error.code,
      message: `Plugin runtime reported ${error.code}.`,
      occurredAt: error.occurredAt,
      revision: instance.lifecycleRevision,
    };
  }
  const declared = grant?.requestedCapabilities.includes(detail.capability) ?? false;
  return {
    code: 'CAPABILITY_NOT_GRANTED',
    capability: detail.capability,
    message: capabilityNotGrantedMessage(detail.capability, declared),
    occurredAt: error.occurredAt,
    revision: instance.lifecycleRevision,
  };
}
