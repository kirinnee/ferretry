/**
 * A login made from a provider preset (docs/provider-presets.md): what the preset fills in, what the
 * person must still give, and the login file that results.
 *
 * The preset decides what a person cannot get wrong — which variables there are, which are secrets,
 * the Codex model provider — and the person decides the rest: the values, the secret NAMES, the cloud
 * credential reference. A secret is never a value here: a secret variable must be a `${secret:NAME}`
 * reference, and the value went into the store through `POST /v1/secrets` before this ever ran.
 *
 * A preset with a `claude:` and a `codex:` half makes ONE login with both halves (`../account/halves.ts`),
 * so one secret drives either CLI. The person's variables arrive as ONE flat set — a half's variable
 * names never clash with the other's — and are put back into the half the preset declares each in.
 *
 * Pure.
 */
import { secretReference, secretReferencesIn } from '@ferretry/protocol';
import { parseCloudCredential } from '../account/environment.ts';
import type { Credential } from '../account/schema.ts';
import type { HarnessKind } from '../manifest.ts';
import { type PresetVariable, type ProviderPreset, presetHarnesses } from './schema.ts';

/** What a person sends to add a login from a preset. */
export interface PresetLoginInput {
  /** Every variable, of every half the login gets, by name. */
  readonly env: Readonly<Record<string, string>>;
  readonly cloudCredential?: string;
  readonly label?: string;
  /**
   * The CLI listed first — what a runtime on the login runs when nothing else says. Left out, the
   * preset's first usable half (Claude Code before Codex).
   */
  readonly harness?: HarnessKind;
  /**
   * The halves the login has, for a login that drives fewer CLIs than its preset offers (an existing
   * one-CLI login whose preset grew a half). Left out, every half the preset offers.
   */
  readonly halves?: readonly HarnessKind[];
}

/** The usable halves a login gets: the ones asked for, else every one the preset offers. */
const loginHalves = (preset: ProviderPreset, halves?: readonly HarnessKind[]): readonly HarnessKind[] =>
  presetHarnesses(preset).filter(harness => halves === undefined || halves.includes(harness));

/** The variables of the halves a login from the preset gets, the first half winning. */
function loginVariables(
  preset: ProviderPreset,
  halves?: readonly HarnessKind[],
): Readonly<Record<string, PresetVariable>> {
  const variables: Record<string, PresetVariable> = {};
  for (const harness of loginHalves(preset, halves).toReversed()) Object.assign(variables, preset.halves[harness]?.env);
  return variables;
}

/** The variables a preset fills in before the person changes anything: plain values and secret references. */
export function presetDefaultEnv(preset: ProviderPreset): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(loginVariables(preset)).map(([name, variable]) => [
      name,
      variable.secretName === undefined ? (variable.value ?? '') : secretReference(variable.secretName),
    ]),
  );
}

/**
 * The secrets a login from the preset needs, each NAME once however many variables carry it: what a
 * one-click form asks for. `required` when some required variable carries it.
 */
export function presetSecrets(
  preset: ProviderPreset,
): readonly { readonly name: string; readonly variables: readonly string[]; readonly required: boolean }[] {
  const byName = new Map<string, { variables: string[]; required: boolean }>();
  for (const [variable, declared] of Object.entries(loginVariables(preset))) {
    if (declared.secretName === undefined) continue;
    const entry = byName.get(declared.secretName) ?? { variables: [], required: false };
    entry.variables.push(variable);
    entry.required ||= declared.required;
    byName.set(declared.secretName, entry);
  }
  return [...byName].map(([name, entry]) => ({ name, ...entry }));
}

/**
 * Why `input` cannot make a login from `preset`, in one sentence, or `undefined` when it can. Every
 * sentence names the variable to fix.
 */
export function presetLoginRefusal(preset: ProviderPreset, input: PresetLoginInput): string | undefined {
  if (preset.unavailable !== undefined) return `${preset.label} is not offered here: ${preset.unavailable}`;
  const halves = loginHalves(preset, input.halves);
  const wanted = input.harness ?? input.halves?.[0];
  if (wanted !== undefined && !halves.includes(wanted)) {
    const reason = preset.halves[wanted]?.unavailable;
    return `${preset.label} does not drive ${wanted === 'claude' ? 'Claude Code' : 'Codex'}${reason === undefined ? '' : `: ${reason}`}`;
  }
  for (const [name, variable] of Object.entries(loginVariables(preset, input.halves))) {
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

/** The variables the person gave that one half declares, an optional one left empty left out. */
const halfEnv = (
  declared: Readonly<Record<string, PresetVariable>>,
  given: Readonly<Record<string, string>>,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(given).filter(
      ([name, value]) => declared[name] !== undefined && (value.length > 0 || declared[name].allowEmpty),
    ),
  );

/**
 * The login a preset and a person's answers make. Call {@link presetLoginRefusal} first: this takes
 * the input as it is. An optional variable left empty is left out, so the login file holds only what
 * the person set; a variable the preset does not know is kept — shared by both halves of a two-CLI
 * login — because a provider grows variables.
 */
export function credentialFromPreset(preset: ProviderPreset, input: PresetLoginInput): Credential {
  const harnesses = loginHalves(preset, input.halves);
  const declared = loginVariables(preset, input.halves);
  const extra = Object.fromEntries(
    Object.entries(input.env).filter(([name, value]) => declared[name] === undefined && value.length > 0),
  );
  const harness = input.harness ?? (harnesses[0] as HarnessKind);
  const common = {
    harness,
    store: 'environment' as const,
    preset: preset.id,
    ...(input.label === undefined ? {} : { label: input.label }),
    ...(input.cloudCredential === undefined ? {} : { cloudCredential: input.cloudCredential }),
  };
  if (harnesses.length === 1) {
    const env = { ...halfEnv(declared, input.env), ...extra };
    const provider = preset.halves[harness]?.codexProvider;
    return {
      ...common,
      ...(Object.keys(env).length === 0 ? {} : { env }),
      ...(provider === undefined ? {} : { codexProvider: provider }),
    };
  }
  const halves = Object.fromEntries(
    harnesses.map(name => {
      const half = preset.halves[name];
      const env = halfEnv(half?.env ?? {}, input.env);
      return [
        name,
        {
          ...(Object.keys(env).length === 0 ? {} : { env }),
          ...(half?.codexProvider === undefined ? {} : { codexProvider: half.codexProvider }),
        },
      ];
    }),
  );
  return { ...common, ...(Object.keys(extra).length === 0 ? {} : { env: extra }), ...halves };
}
