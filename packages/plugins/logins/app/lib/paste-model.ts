/**
 * What a pasted block of variables becomes (docs/provider-presets.md § Detect): the paste is read in
 * this browser by Logins' own detection (`contract/detect.ts`), recognised from the presets' clues,
 * and mapped onto a preset's form.
 *
 * NO VALUE IS EVER PUT IN A SENTENCE. Detection reports variable NAMES and the host as the PRESET
 * declares it; this module words those. A pasted value only travels from the paste to the field it
 * fills — a plain value into its field, a secret's nowhere near a field: the form takes a
 * `${secret:NAME}` reference, never the key itself, so a pasted key is only ever named, and the
 * person is told to paste it into the secret store.
 */

import {
  type DetectablePreset,
  detectProvider,
  type ProviderDetection,
  parseVariableBlock,
} from '../../contract/detect.ts';
import type { ProviderPresetView } from '../../contract/index.ts';

/** The preset a paste falls back to when nothing is recognised: the one for any gateway. */
export const CUSTOM_GATEWAY = 'custom-gateway';

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
export const prefillFrom = (preset: ProviderPresetView, pasted: Readonly<Record<string, string>>): Prefill => {
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

/** The detection table, from the presets that declare clues. */
export const detectTable = (presets: readonly ProviderPresetView[]): readonly DetectablePreset[] =>
  presets.flatMap(preset => (preset.detect === undefined ? [] : [{ id: preset.id, detect: preset.detect }]));

/** A paste, read: its variables (held in memory, never shown) and what they were recognised as. */
export interface PasteReading {
  readonly values: Readonly<Record<string, string>>;
  readonly detection: ProviderDetection;
}

export const readPaste = (presets: readonly ProviderPresetView[], text: string): PasteReading => {
  const values = parseVariableBlock(text);
  return { values, detection: detectProvider(detectTable(presets), values) };
};

const labelOf = (presets: readonly ProviderPresetView[], id: string): string =>
  presets.find(preset => preset.id === id)?.label ?? id;

/**
 * What a paste was recognised as, by NAMES only: "Looks like DeepSeek — from ANTHROPIC_BASE_URL
 * (api.deepseek.com) · DEEPSEEK_API_KEY", or "Custom gateway — recognised: X, Y".
 */
export const detectionSentence = (presets: readonly ProviderPresetView[], detection: ProviderDetection): string => {
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
  presets: readonly ProviderPresetView[],
  detection: ProviderDetection,
): string | null =>
  detection.alsoMatched.length === 0 ? null : `or: ${detection.alsoMatched.map(id => labelOf(presets, id)).join(', ')}`;

/**
 * The preset Continue opens: the one recognised when it is offered here, else the custom gateway, else
 * none.
 */
export const pasteTarget = (
  presets: readonly ProviderPresetView[],
  detection: ProviderDetection,
): ProviderPresetView | undefined => {
  const usable = (id: string | undefined) => presets.find(preset => preset.id === id && preset.offered.available);
  return usable(detection.preset) ?? usable(CUSTOM_GATEWAY);
};
