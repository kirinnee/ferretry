/**
 * What an ENVIRONMENT login says and sends — the pure half (docs/provider-presets.md).
 *
 * An environment login is a named set of variables injected into the CLI at launch. A preset fills in
 * the names, which of them are secrets, and the values a provider documents; the person fills in the
 * rest. A secret is never a value here: it goes into the secret store first and the login holds only
 * `${secret:NAME}`. This module turns a preset and a draft into that change, and words the scope, the
 * quota source and the Test.
 */

import type {
  FleetAccountChange,
  FleetCredentialList,
  FleetCredentialTestAct,
  FleetCredentialTestResult,
  FleetProviderPresetView,
} from '@ferretry/protocol';
import type { HarnessKind } from './credentials-model.ts';

/** One CLI a preset has a half for, and whether that half is offered here. */
export type PresetHalf = NonNullable<FleetProviderPresetView['halves']>[number];

/** Every half of a preset. A daemon that predates halves sends none: the preset's one CLI is its half. */
export const presetHalves = (preset: FleetProviderPresetView): readonly PresetHalf[] =>
  preset.halves ?? [{ harness: preset.harness, offered: preset.offered, models: preset.models }];

/** The CLIs a login made from this preset drives: every offered half, Claude Code first. None when not offered. */
export const offeredHarnesses = (preset: FleetProviderPresetView): readonly HarnessKind[] =>
  preset.offered.available
    ? presetHalves(preset)
        .filter(half => half.offered.available)
        .map(half => half.harness)
    : [];

/** What a preset's scope chip says: its offered halves, or — when none is — the CLI it is for. */
export const presetScope = (preset: FleetProviderPresetView): readonly HarnessKind[] => {
  const offered = offeredHarnesses(preset);
  return offered.length === 0 ? [preset.harness] : offered;
};

/**
 * The presets to offer, in the daemon's order. Opened for one CLI (from Add a runtime), only the ones
 * with an offered half for it — the login still gets every half the preset offers.
 */
export const presetsFor = (
  presets: readonly FleetProviderPresetView[],
  harness?: HarnessKind,
): readonly FleetProviderPresetView[] =>
  harness === undefined ? presets : presets.filter(preset => offeredHarnesses(preset).includes(harness));

/** The `credential.add` CLI: the first offered half (the login gets the rest), else the preset's own. */
export const loginHarness = (preset: FleetProviderPresetView): HarnessKind =>
  offeredHarnesses(preset)[0] ?? preset.harness;

/** What a person is filling in: each variable's value, or the secret name it is stored under. */
export interface EnvironmentDraft {
  readonly name: string;
  readonly values: Readonly<Record<string, string>>;
  readonly secrets: Readonly<Record<string, string>>;
  readonly cloudCredential: string;
}

/** A free id from a preset id: `zai-glm`, `zai-glm-2`, … past every id this machine has. */
export const freeLoginId = (list: FleetCredentialList | null, base: string): string => {
  const taken = new Set((list?.credentials ?? []).map(credential => credential.id));
  if (!taken.has(base)) return base;
  let index = 2;
  while (taken.has(`${base}-${String(index)}`)) index += 1;
  return `${base}-${String(index)}`;
};

/** The draft a preset starts from. */
export const presetDraft = (preset: FleetProviderPresetView, list: FleetCredentialList | null): EnvironmentDraft => ({
  name: freeLoginId(list, preset.id),
  values: Object.fromEntries(
    preset.variables
      .filter(variable => variable.kind === 'plain')
      .map(variable => [variable.name, variable.value ?? '']),
  ),
  secrets: Object.fromEntries(
    preset.variables
      .filter(variable => variable.kind === 'secret')
      .map(variable => [variable.name, variable.secret ?? variable.name]),
  ),
  cloudCredential: preset.cloudCredential?.suggested ?? '',
});

/** `${secret:NAME}`. */
export const secretRef = (name: string): string => `\${secret:${name}}`;

/**
 * Why the draft cannot be added yet, or `null`. Names the first thing to fix. A required plain value may
 * be empty only where the preset means it to be (`allowEmpty`, as `ANTHROPIC_API_KEY: ""`). `ready` is
 * every secret name the store holds or that was pasted to be stored on Add.
 */
export const environmentDraftProblem = (
  preset: FleetProviderPresetView,
  draft: EnvironmentDraft,
  ready: ReadonlySet<string>,
): string | null => {
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(draft.name)) return 'Name it with lowercase letters, digits and dashes.';
  for (const variable of preset.variables) {
    if (variable.kind === 'plain') {
      if (variable.required && !variable.allowEmpty && (draft.values[variable.name] ?? '').trim() === '')
        return `Fill in ${variable.name}.`;
      continue;
    }
    const secret = draft.secrets[variable.name] ?? '';
    if (variable.required && !ready.has(secret)) return `Paste ${secret}.`;
  }
  if (preset.cloudCredential !== undefined && draft.cloudCredential.trim() === '')
    return 'Fill in the cloud credential reference.';
  return null;
};

/**
 * The reviewed change that adds the login: ONE flat set of every half's variables, so a preset with two
 * offered halves makes one login that drives both. An optional variable left empty is left out.
 */
export const environmentChange = (
  preset: FleetProviderPresetView,
  draft: EnvironmentDraft,
  stored: ReadonlySet<string>,
): Extract<FleetAccountChange, { kind: 'credential.add' }> => {
  const env: Record<string, string> = {};
  for (const variable of preset.variables) {
    if (variable.kind === 'secret') {
      const secret = draft.secrets[variable.name] ?? '';
      if (variable.required || stored.has(secret)) env[variable.name] = secretRef(secret);
      continue;
    }
    const value = (draft.values[variable.name] ?? '').trim();
    // An empty value is sent only where the preset means it (ANTHROPIC_API_KEY: "" so a token wins); an
    // optional one left empty is left out.
    if (value !== '' || (variable.required && variable.allowEmpty)) env[variable.name] = value;
  }
  return {
    kind: 'credential.add',
    id: draft.name,
    harness: loginHarness(preset),
    store: 'environment',
    preset: preset.id,
    env,
    ...(preset.cloudCredential === undefined ? {} : { cloudCredential: draft.cloudCredential.trim() }),
  };
};

/** What the Test button says before it is pressed. */
export const testNote = (act: FleetCredentialTestAct): string => (act.available ? act.note : act.reason);

/** The inline consent a one-token Test asks for. */
export const TEST_CONSENT =
  'This provider has no free check, so the Test sends one message capped at one token — a fraction of a cent. Send it?';

/** One Test answer, as the line under the button. */
export const testResultLine = (result: FleetCredentialTestResult): string =>
  result.ok
    ? `Test passed${result.spent === 'one-token' ? ' — one token spent' : ' — nothing spent'}.`
    : result.message;
