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
import { plainPaste, type WithheldReason } from '../../contract/secret-shape.ts';

/** The preset a paste falls back to when nothing is recognised: the one for any gateway. */
export const CUSTOM_GATEWAY = 'custom-gateway';

/** A pasted variable that was not put in a field, by NAME, and why. Never its value. */
export interface Withheld {
  readonly name: string;
  readonly reason: Exclude<WithheldReason, 'allow-empty'>;
}

/**
 * What a paste fills in: plain values by variable name, the secrets it carried by secret NAME only (the value is dropped
 * where it is read), and the plain variables whose value was kept out of a field.
 */
export interface Prefill {
  readonly values: Readonly<Record<string, string>>;
  readonly secrets: readonly string[];
  readonly withheld: readonly Withheld[];
}

/**
 * A paste mapped onto a preset, by name: a plain variable takes its value; a variable the preset makes
 * a secret gives that secret's value, as does a pasted variable named like the secret itself
 * (`ZAI_API_KEY` for the secret behind `ANTHROPIC_AUTH_TOKEN`), named only. A plain variable whose name reads as a
 * credential, whose value has a token shape or is an address with a user or query, or that the preset leaves empty on
 * purpose, is NOT filled ({@link plainPaste}). Anything else is left behind.
 */
export const prefillFrom = (preset: ProviderPresetView, pasted: Readonly<Record<string, string>>): Prefill => {
  const values: Record<string, string> = {};
  const secrets: string[] = [];
  const withheld: Withheld[] = [];
  for (const variable of preset.variables) {
    const value = pasted[variable.name];
    if (variable.kind === 'plain') {
      if (value === undefined) continue;
      const verdict = plainPaste(variable.name, value, variable.allowEmpty);
      if (verdict.kind === 'take') values[variable.name] = verdict.value;
      else if (verdict.reason !== 'allow-empty') withheld.push({ name: variable.name, reason: verdict.reason });
      continue;
    }
    const secret = variable.secret ?? variable.name;
    const given = value ?? pasted[secret];
    if (given !== undefined && given !== '' && !secrets.includes(secret)) secrets.push(secret);
  }
  return { values, secrets, withheld };
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

/** The sentence for the variables a paste left out of the form: names and a reason, never a value. */
export const withheldSentence = (withheld: readonly Withheld[]): string | null => {
  if (withheld.length === 0) return null;
  const secret = withheld.filter(item => item.reason === 'credential-name' || item.reason === 'token-shape');
  const address = withheld.filter(item => item.reason === 'url-userinfo' || item.reason === 'url-query');
  return [
    secret.length === 0
      ? null
      : `${secret.map(item => item.name).join(', ')} read${secret.length === 1 ? 's' : ''} as a key, so it was not filled in: a key is stored in the secret store, never typed into a field.`,
    address.length === 0
      ? null
      : `${address.map(item => item.name).join(', ')} carried a user, a password or a query string, so it was not filled in: type the plain address.`,
  ]
    .filter(part => part !== null)
    .join(' ');
};
