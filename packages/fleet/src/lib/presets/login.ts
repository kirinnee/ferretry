/**
 * A login made from a provider preset (docs/provider-presets.md): what the preset fills in, what the
 * person must still give, and the login file that results.
 *
 * The preset decides what a person cannot get wrong — which variables there are, which are secrets,
 * the Codex model provider — and the person decides the rest: the values, the secret NAMES, the cloud
 * credential reference. A secret is never a value here: a secret variable must be a `${secret:NAME}`
 * reference, and the value went into the store through `POST /v1/secrets` before this ever ran.
 *
 * Pure.
 */
import { secretReference, secretReferencesIn } from '@ferretry/protocol';
import { parseCloudCredential } from '../account/environment.ts';
import type { Credential } from '../account/schema.ts';
import type { ProviderPreset } from './schema.ts';

/** What a person sends to add a login from a preset. */
export interface PresetLoginInput {
  readonly env: Readonly<Record<string, string>>;
  readonly cloudCredential?: string;
  readonly label?: string;
}

/** The variables a preset fills in before the person changes anything: plain values and secret references. */
export function presetDefaultEnv(preset: ProviderPreset): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(preset.env).map(([name, variable]) => [
      name,
      variable.secretName === undefined ? (variable.value ?? '') : secretReference(variable.secretName),
    ]),
  );
}

/**
 * Why `input` cannot make a login from `preset`, in one sentence, or `undefined` when it can. Every
 * sentence names the variable to fix.
 */
export function presetLoginRefusal(preset: ProviderPreset, input: PresetLoginInput): string | undefined {
  if (preset.unavailable !== undefined) return `${preset.label} is not offered here: ${preset.unavailable}`;
  for (const [name, variable] of Object.entries(preset.env)) {
    const value = input.env[name];
    const given = value !== undefined && (value.length > 0 || variable.allowEmpty);
    if (!given) {
      if (variable.required) return `${name} is needed for ${preset.label} — fill it in`;
      continue;
    }
    if (variable.secretName !== undefined && secretReferencesIn(value).length === 0) {
      return `${name} is a secret: store it in the secret store and write \${secret:NAME} here, never the value`;
    }
  }
  const reference = input.cloudCredential;
  if (preset.cloudCredential === undefined) {
    if (reference !== undefined) return `${preset.label} takes no cloud credential reference`;
    return undefined;
  }
  if (reference === undefined) {
    return `${preset.label} needs a cloud credential reference: ${preset.cloudCredential.kinds.join(' or ')}`;
  }
  const parsed = parseCloudCredential(reference);
  if (parsed === undefined || !preset.cloudCredential.kinds.includes(parsed.kind)) {
    return `${preset.label} takes a cloud credential reference of kind ${preset.cloudCredential.kinds.join(' or ')}`;
  }
  return undefined;
}

/**
 * The login a preset and a person's answers make. Call {@link presetLoginRefusal} first: this takes
 * the input as it is. An optional variable left empty is left out, so the login file holds only what
 * the person set; a variable the preset does not know is kept, because a provider grows variables.
 */
export function credentialFromPreset(preset: ProviderPreset, input: PresetLoginInput): Credential {
  const env = Object.fromEntries(
    Object.entries(input.env).filter(([name, value]) => value.length > 0 || preset.env[name]?.allowEmpty === true),
  );
  return {
    harness: preset.harness,
    store: 'environment',
    preset: preset.id,
    ...(input.label === undefined ? {} : { label: input.label }),
    ...(Object.keys(env).length === 0 ? {} : { env }),
    ...(input.cloudCredential === undefined ? {} : { cloudCredential: input.cloudCredential }),
    ...(preset.codexProvider === undefined ? {} : { codexProvider: preset.codexProvider }),
  };
}
