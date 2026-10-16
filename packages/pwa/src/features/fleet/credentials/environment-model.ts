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

/** The preset groups, in the order the select lists them. */
export const PRESET_GROUPS: readonly { readonly harness: HarnessKind; readonly label: string }[] = [
  { harness: 'claude', label: 'Claude Code' },
  { harness: 'codex', label: 'Codex' },
];

/** The presets of one harness, in the daemon's order. */
export const presetsOf = (
  presets: readonly FleetProviderPresetView[],
  harness: HarnessKind,
): readonly FleetProviderPresetView[] => presets.filter(preset => preset.harness === harness);

/** The first preset that may add a login, for a harness when one is fixed. */
export const firstOffered = (
  presets: readonly FleetProviderPresetView[],
  harness?: HarnessKind,
): FleetProviderPresetView | undefined =>
  presets.find(preset => preset.offered.available && (harness === undefined || preset.harness === harness));

/** One select option's words: a preset that is not offered says why. */
export const presetOptionLabel = (preset: FleetProviderPresetView): string =>
  preset.offered.available ? preset.label : `${preset.label} — not offered: ${preset.offered.reason}`;

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
 * be empty only where the preset means it to be (`allowEmpty`, as `ANTHROPIC_API_KEY: ""`).
 */
export const environmentDraftProblem = (
  preset: FleetProviderPresetView,
  draft: EnvironmentDraft,
  stored: ReadonlySet<string>,
): string | null => {
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(draft.name)) return 'Name it with lowercase letters, digits and dashes.';
  for (const variable of preset.variables) {
    if (variable.kind === 'plain') {
      if (variable.required && !variable.allowEmpty && (draft.values[variable.name] ?? '').trim() === '')
        return `Fill in ${variable.name}.`;
      continue;
    }
    const secret = draft.secrets[variable.name] ?? '';
    if (variable.required && !stored.has(secret)) return `Store ${secret} first.`;
  }
  if (preset.cloudCredential !== undefined && draft.cloudCredential.trim() === '')
    return 'Fill in the cloud credential reference.';
  return null;
};

/** The reviewed change that adds the login. An optional variable left empty is left out. */
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
    harness: preset.harness,
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
