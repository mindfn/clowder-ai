/** The beta.19 manifest predicate, shared by Host admission, readiness, and Console. */
export interface PluginConditionalRequirement {
  readonly required: boolean;
  readonly requiredWhen?: {
    readonly key: string;
    readonly value: string | number | boolean | readonly (string | number | boolean)[];
  };
}

/**
 * Whether the field's `requiredWhen` condition currently holds. Fields without a condition
 * are always applicable. Hosts hide, skip validation for, and never persist an inapplicable
 * field: the beta.19 contract already defines `requiredWhen` as "required iff the condition
 * holds", so a field whose condition is unmet has no use in the current configuration.
 */
export function isPluginConfigurationFieldConditionMet(
  field: Pick<PluginConditionalRequirement, 'requiredWhen'>,
  effectiveValueOf: (key: string) => string | undefined,
): boolean {
  if (!field.requiredWhen) return true;
  const actual = effectiveValueOf(field.requiredWhen.key);
  if (actual === undefined) return false;
  const expected = Array.isArray(field.requiredWhen.value) ? field.requiredWhen.value : [field.requiredWhen.value];
  return expected.some((value) => String(value) === actual);
}

/** An explicit condition takes precedence over unconditional `required`. */
export function isPluginConfigurationFieldRequired(
  field: PluginConditionalRequirement,
  effectiveValueOf: (key: string) => string | undefined,
): boolean {
  if (!field.requiredWhen) return field.required;
  return isPluginConfigurationFieldConditionMet(field, effectiveValueOf);
}
