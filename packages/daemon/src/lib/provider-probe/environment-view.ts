/**
 * An environment login as the Logins screen shows it (docs/provider-presets.md): each variable as a
 * plain value or as the NAMES of the secrets it is made from with "set ✓", its cloud credential
 * reference in words, its Codex provider, its preset, what it still needs, and its Test.
 *
 * NO VALUE OF A SECRET IS HERE, AND NONE IS READ. Whether a secret is set is a NAME lookup in the
 * store's listing; a variable whose value looks like a key and is not a reference — which a file would
 * have been refused for, so it can only be a hand edit the watcher has not judged yet — is reported
 * as hidden rather than shown.
 */
import {
  type Credential,
  cloudCredentialSentence,
  cloudCredentialVariable,
  looksLikeRawSecret,
  looksSecret,
  type ProviderPreset,
  parseCloudCredential,
} from '@ferretry/fleet';
import { type FleetCredentialEnvironment, type FleetEnvironmentVariable, secretReferencesIn } from '@ferretry/protocol';
import { planProviderProbe } from './plan.ts';
import { presetTestAct } from './presets.ts';

/** One variable as it may travel. */
function variableView(name: string, value: string, held: ReadonlySet<string> | undefined): FleetEnvironmentVariable {
  const secrets = secretReferencesIn(value);
  if (secrets.length > 0) {
    return { name, kind: 'secret', secrets: [...secrets], set: held !== undefined && secrets.every(s => held.has(s)) };
  }
  if (looksSecret(name, value) || looksLikeRawSecret(name, value)) return { name, kind: 'hidden' };
  return { name, kind: 'plain', value };
}

/**
 * The environment part of one login's row. `held` is the store's secret names, or `undefined` when the
 * store cannot be listed — every secret then reads as not set, and nothing reads as missing, because a
 * store that cannot be read is not a store that is empty.
 */
export function credentialEnvironmentView(
  credential: Credential,
  presets: readonly ProviderPreset[],
  held: ReadonlySet<string> | undefined,
): FleetCredentialEnvironment {
  const env = credential.env ?? {};
  const preset = credential.preset === undefined ? undefined : presets.find(entry => entry.id === credential.preset);
  const variables = Object.entries(env)
    .toSorted(([left], [right]) => (left < right ? -1 : 1))
    .map(([name, value]) => variableView(name, value, held));
  const named = [...new Set(Object.values(env).flatMap(value => secretReferencesIn(value)))];
  const reference =
    credential.cloudCredential === undefined ? undefined : parseCloudCredential(credential.cloudCredential);
  const variable = reference === undefined ? undefined : cloudCredentialVariable(reference);
  return {
    ...(preset === undefined ? {} : { preset: { id: preset.id, label: preset.label, docs: preset.docs } }),
    ...(credential.preset !== undefined && preset === undefined ? { missingPreset: credential.preset } : {}),
    variables,
    ...(reference === undefined || credential.cloudCredential === undefined
      ? {}
      : {
          cloudCredential: {
            reference: credential.cloudCredential,
            kind: reference.kind,
            sentence: `Uses ${cloudCredentialSentence(reference)}. It is named here, never copied.`,
            ...(variable === undefined ? {} : { variable }),
          },
        }),
    ...(credential.codexProvider === undefined
      ? {}
      : {
          codexProvider: {
            id: credential.codexProvider.id,
            name: credential.codexProvider.name ?? credential.codexProvider.id,
            ...(credential.codexProvider.baseUrl === undefined ? {} : { baseUrl: credential.codexProvider.baseUrl }),
          },
        }),
    quotaSource: preset?.quota.source ?? 'transcript-pricing',
    missingSecrets: held === undefined ? [] : named.filter(name => !held.has(name)),
    test: testAct(credential, preset),
  };
}

/** Whether this login can be tested now, and what it would spend. */
function testAct(credential: Credential, preset: ProviderPreset | undefined): FleetCredentialEnvironment['test'] {
  if (preset === undefined) {
    return {
      available: false,
      reason:
        credential.preset === undefined
          ? 'This login was not made from a preset, so Ferretry does not know a safe way to test it. Start an agent on it to check.'
          : `Preset ${credential.preset} is not on this machine any more, so Ferretry does not know how to test this login.`,
    };
  }
  const act = presetTestAct(preset.test);
  if (!act.available) return act;
  const plan = planProviderProbe(preset, credential);
  return 'reason' in plan ? { available: false, reason: plan.reason } : act;
}
