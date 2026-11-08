/** A machine's feature list is no longer asked (one build, one contract): handlers keyed on `/v1/health` are never called. */
export const healthOf = (version: string, features: readonly string[]): unknown => ({ version, features });
