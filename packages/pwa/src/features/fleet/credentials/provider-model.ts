/**
 * One-click providers — the pure half (docs/provider-presets.md): the grid's order, what the minimal
 * form asks for, and what a pasted block of variables is read as.
 *
 * NO VALUE IS EVER PUT IN A SENTENCE. Detection (`@ferretry/fleet/detect`) reports variable NAMES and
 * the host as the PRESET declares it; this module words those. A pasted value only travels from the
 * paste to the field it fills — a secret's into the secret store on Add, never onto the screen.
 */

import {
  type DetectablePreset,
  detectProvider,
  type ProviderDetection,
  parseVariableBlock,
} from '@ferretry/fleet/detect';
import type { FleetCredentialList, FleetProviderPresetView } from '@ferretry/protocol';
import { type EnvironmentDraft, offeredHarnesses, presetDraft } from './environment-model.ts';

/** The preset the grid keeps last, beside Paste variables: it is the one for everything else. */
export const CUSTOM_GATEWAY = 'custom-gateway';

/** The grid's tiles, in the daemon's order, with the custom gateway moved to the end. */
export const gridPresets = (presets: readonly FleetProviderPresetView[]): readonly FleetProviderPresetView[] => [
  ...presets.filter(preset => preset.id !== CUSTOM_GATEWAY),
  ...presets.filter(preset => preset.id === CUSTOM_GATEWAY),
];

/** One secret the minimal form asks for, by NAME: the variables it fills, and whether the login needs it. */
export interface SecretField {
  readonly secret: string;
  readonly variables: readonly string[];
  readonly required: boolean;
}

/** Each secret NAME a preset uses once — one key for both halves is one field — in the preset's order. */
export const secretFields = (preset: FleetProviderPresetView): readonly SecretField[] => {
  const fields = new Map<string, SecretField>();
  for (const variable of preset.variables) {
    if (variable.kind !== 'secret') continue;
    const secret = variable.secret ?? variable.name;
    const seen = fields.get(secret);
    fields.set(secret, {
      secret,
      variables: [...(seen?.variables ?? []), variable.name],
      required: (seen?.required ?? false) || variable.required,
    });
  }
  return [...fields.values()];
};

/** The plain values the minimal form asks for: required, with no default, and not empty on purpose. */
export const blankRequiredValues = (preset: FleetProviderPresetView): readonly string[] =>
  preset.variables
    .filter(variable => variable.kind === 'plain' && variable.required && !variable.allowEmpty && !variable.value)
    .map(variable => variable.name);

/** What a paste fills in: plain values by variable name, and secret values by secret NAME. */
export interface Prefill {
  readonly values: Readonly<Record<string, string>>;
  readonly secrets: Readonly<Record<string, string>>;
}

/**
 * A paste mapped onto a preset, by name: a plain variable takes its value; a variable the preset makes
 * a secret gives that secret's value, as does a pasted variable named like the secret itself
 * (`ZAI_API_KEY` for the secret behind `ANTHROPIC_AUTH_TOKEN`). Anything else is left behind.
 */
export const prefillFrom = (preset: FleetProviderPresetView, pasted: Readonly<Record<string, string>>): Prefill => {
  const values: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  for (const variable of preset.variables) {
    const value = pasted[variable.name];
    if (variable.kind === 'plain') {
      if (value !== undefined) values[variable.name] = value;
      continue;
    }
    const secret = variable.secret ?? variable.name;
    const given = value ?? pasted[secret];
    if (given !== undefined && given !== '' && secrets[secret] === undefined) secrets[secret] = given;
  }
  return { values, secrets };
};

/** The draft the minimal form starts from: the preset's, with a paste's plain values over it. */
export const oneClickDraft = (
  preset: FleetProviderPresetView,
  list: FleetCredentialList | null,
  prefill?: Prefill,
): EnvironmentDraft => {
  const draft = presetDraft(preset, list);
  return { ...draft, values: { ...draft.values, ...prefill?.values } };
};

/** The detection table, from the presets that declare clues. */
export const detectTable = (presets: readonly FleetProviderPresetView[]): readonly DetectablePreset[] =>
  presets.flatMap(preset => (preset.detect === undefined ? [] : [{ id: preset.id, detect: preset.detect }]));

/** A paste, read: its variables (held in memory, never shown) and what they were recognised as. */
export interface PasteReading {
  readonly values: Readonly<Record<string, string>>;
  readonly detection: ProviderDetection;
}

export const readPaste = (presets: readonly FleetProviderPresetView[], text: string): PasteReading => {
  const values = parseVariableBlock(text);
  return { values, detection: detectProvider(detectTable(presets), values) };
};

const labelOf = (presets: readonly FleetProviderPresetView[], id: string): string =>
  presets.find(preset => preset.id === id)?.label ?? id;

/**
 * What a paste was recognised as, by NAMES only: "Looks like DeepSeek — from ANTHROPIC_BASE_URL
 * (api.deepseek.com) · DEEPSEEK_API_KEY", or "Custom gateway — recognised: X, Y".
 */
export const detectionSentence = (
  presets: readonly FleetProviderPresetView[],
  detection: ProviderDetection,
): string => {
  if (detection.preset === undefined)
    return detection.recognised.length === 0
      ? 'Custom gateway — no variable recognised'
      : `Custom gateway — recognised: ${detection.recognised.join(', ')}`;
  const said = new Map<string, string>();
  for (const clue of detection.clues)
    if (clue.kind === 'host') said.set(clue.variable, `${clue.variable} (${clue.host})`);
    else if (!said.has(clue.variable)) said.set(clue.variable, clue.variable);
  return `Looks like ${labelOf(presets, detection.preset)} — from ${[...said.values()].join(' · ')}`;
};

/** "or: Kimi, MiniMax" when other presets matched as well, else `null`. */
export const alsoMatchedSentence = (
  presets: readonly FleetProviderPresetView[],
  detection: ProviderDetection,
): string | null =>
  detection.alsoMatched.length === 0 ? null : `or: ${detection.alsoMatched.map(id => labelOf(presets, id)).join(', ')}`;

/**
 * The preset Continue opens: the one recognised when it is offered here, else the custom gateway, else
 * none.
 */
export const pasteTarget = (
  presets: readonly FleetProviderPresetView[],
  detection: ProviderDetection,
): FleetProviderPresetView | undefined => {
  const usable = (id: string | undefined) =>
    presets.find(preset => preset.id === id && offeredHarnesses(preset).length > 0);
  return usable(detection.preset) ?? usable(CUSTOM_GATEWAY);
};
