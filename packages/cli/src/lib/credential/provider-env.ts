/**
 * The variables and secrets a one-click login needs, read off the wire preset catalogue
 * (`FleetProviderPresetView`, docs/provider-presets.md) rather than the fleet package's own internal
 * preset shape, which the CLI never holds.
 *
 * Pure.
 */
import type { FleetPresetVariable, FleetProviderPresetView } from '@ferretry/protocol';
import type { AccountHarness } from '../fleet/account-ports.ts';

/** Whether a preset variable belongs to one of `harnesses`: shared (no `harnesses`) or an overlap. */
const appliesTo = (variable: FleetPresetVariable, harnesses: readonly AccountHarness[]): boolean =>
  variable.harnesses === undefined || variable.harnesses.some(harness => harnesses.includes(harness));

/** Every variable of `preset` that the given halves set. */
function presetVariablesFor(
  preset: FleetProviderPresetView,
  harnesses: readonly AccountHarness[],
): readonly FleetPresetVariable[] {
  return preset.variables.filter(variable => appliesTo(variable, harnesses));
}

/** One secret a login needs: its suggested NAME, and every variable that carries it. */
export interface PresetSecretNeed {
  readonly name: string;
  readonly variables: readonly string[];
}

/** The secrets a login from `preset` needs for `harnesses`, each NAME once however many variables carry it. */
export function presetSecretsNeeded(
  preset: FleetProviderPresetView,
  harnesses: readonly AccountHarness[],
): readonly PresetSecretNeed[] {
  const byName = new Map<string, string[]>();
  for (const variable of presetVariablesFor(preset, harnesses)) {
    if (variable.kind !== 'secret') continue;
    const name = variable.secret ?? variable.name;
    byName.set(name, [...(byName.get(name) ?? []), variable.name]);
  }
  return [...byName].map(([name, variables]) => ({ name, variables }));
}

/** The variables a preset fills in before anyone changes anything: plain values, secrets as references. */
export function presetDefaultEnv(
  preset: FleetProviderPresetView,
  harnesses: readonly AccountHarness[],
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const variable of presetVariablesFor(preset, harnesses)) {
    env[variable.name] =
      variable.kind === 'secret' ? `\${secret:${variable.secret ?? variable.name}}` : (variable.value ?? '');
  }
  return env;
}

/**
 * `env`, with a plain variable's value taken from the shell wherever the preset declares that name and
 * the shell carries a non-empty one (`fy login add --from-env`, docs/provider-presets.md). A secret
 * variable is never read this way: its value is spent through {@link secretFromShell} instead.
 */
export function withShellPlainValues(
  preset: FleetProviderPresetView,
  harnesses: readonly AccountHarness[],
  env: Readonly<Record<string, string>>,
  shellEnv: Readonly<Record<string, string>>,
): Record<string, string> {
  const plainNames = new Set(
    presetVariablesFor(preset, harnesses)
      .filter(variable => variable.kind === 'plain')
      .map(variable => variable.name),
  );
  const overrides = Object.fromEntries(
    Object.entries(shellEnv).filter(([name, value]) => plainNames.has(name) && value !== ''),
  );
  return { ...env, ...overrides };
}

/**
 * A required plain variable `env` still leaves empty: asked interactively, taken from `--env`, or
 * refused by name. A secret variable is never one of these — it is filled through the secret store.
 */
export function presetRequiredPlainGaps(
  preset: FleetProviderPresetView,
  harnesses: readonly AccountHarness[],
  env: Readonly<Record<string, string>>,
): readonly FleetPresetVariable[] {
  return presetVariablesFor(preset, harnesses).filter(
    variable =>
      variable.kind === 'plain' && variable.required && !variable.allowEmpty && (env[variable.name] ?? '') === '',
  );
}

/** The value of the first of `need`'s variables the shell carries a non-empty value for, or `undefined`. */
export function secretFromShell(
  need: PresetSecretNeed,
  shellEnv: Readonly<Record<string, string>>,
): string | undefined {
  for (const name of need.variables) {
    const value = shellEnv[name];
    if (value !== undefined && value !== '') return value;
  }
  return undefined;
}
