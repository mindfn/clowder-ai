/** The beta.19 manifest predicate, shared by Host admission, readiness, and Console. */
export interface PluginConditionalRequirement {
  readonly required: boolean;
  readonly requiredWhen?: {
    readonly key: string;
    readonly value: string | number | boolean | readonly (string | number | boolean)[];
  };
}

/** An explicit condition takes precedence over unconditional `required`. */
export function isPluginConfigurationFieldRequired(
  field: PluginConditionalRequirement,
  effectiveValueOf: (key: string) => string | undefined,
): boolean {
  if (!field.requiredWhen) return field.required;
  const actual = effectiveValueOf(field.requiredWhen.key);
  if (actual === undefined) return false;
  const expected = Array.isArray(field.requiredWhen.value) ? field.requiredWhen.value : [field.requiredWhen.value];
  return expected.some((value) => String(value) === actual);
}

/** The conditional-visibility predicate (beta.37): without `visibleWhen` a field stays visible. */
export interface PluginConditionalVisibility {
  readonly visibleWhen?: {
    readonly key: string;
    readonly value: string | number | boolean | readonly (string | number | boolean)[];
  };
}

export function isPluginConfigurationFieldVisible(
  field: PluginConditionalVisibility,
  effectiveValueOf: (key: string) => string | undefined,
): boolean {
  if (!field.visibleWhen) return true;
  const actual = effectiveValueOf(field.visibleWhen.key);
  if (actual === undefined) return false;
  const expected = Array.isArray(field.visibleWhen.value) ? field.visibleWhen.value : [field.visibleWhen.value];
  return expected.some((value) => String(value) === actual);
}

