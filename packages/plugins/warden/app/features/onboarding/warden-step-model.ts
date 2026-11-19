/**
 * The Warden's first-run page, worked out without a browser: the three answers, what each one writes to `warden.yaml`,
 * which answer a machine's settings already spell, and whether the person has already written the file.
 *
 * The three cards are cumulative, in the order they cost: the rules alone are free; Jev adds a cheap guard that clears
 * flags it is sure are healthy; the LLM investigation adds a read-only look at every flag Jev passed on. Each answer
 * writes ONLY `enabled` and the two `layers`, so nothing else the person (or a hand edit) put in the file moves.
 */

import type { WardenConfig, WardenConfigPatch } from '../../wire.ts';

export type WardenChoice = 'rules' | 'jev' | 'llm';

export interface WardenChoiceCopy {
  readonly id: WardenChoice;
  readonly title: string;
  readonly line: string;
}

export const WARDEN_CHOICES: readonly WardenChoiceCopy[] = [
  {
    id: 'rules',
    title: 'Rules only',
    line: 'Free. Rules spot a stuck or dead ferret and show it to you. No AI runs and nothing is spent.',
  },
  {
    id: 'jev',
    title: '+ Jev',
    line: 'A cheap check clears the flags it is sure are fine. Needs a Jev key; up to $0.50 a day.',
  },
  {
    id: 'llm',
    title: '+ LLM investigation',
    line: 'A read-only AI look at every flag Jev passes on. Up to $2 a day more.',
  },
];

/** The layers each answer turns on. */
const LAYERS: Readonly<Record<WardenChoice, { readonly jev: boolean; readonly llm: boolean }>> = {
  rules: { jev: false, llm: false },
  jev: { jev: true, llm: false },
  llm: { jev: true, llm: true },
};

/** The smallest PATCH an answer needs: the Warden on, and the two layers. Written even when it equals the defaults. */
export const patchFor = (choice: WardenChoice): WardenConfigPatch => ({
  enabled: true,
  layers: { ...LAYERS[choice] },
});

/** Which card the settings in effect already spell: the highest layer that is on. */
export const choiceOf = (config: Pick<WardenConfig, 'layers'>): WardenChoice =>
  config.layers.llm ? 'llm' : config.layers.jev ? 'jev' : 'rules';

/** Whether the person has already written `warden.yaml`: a file that exists and says at least one thing. */
export const wardenFileWritten = (read: { readonly exists: boolean; readonly written?: unknown }): boolean => {
  if (!read.exists) return false;
  const written = read.written;
  return typeof written === 'object' && written !== null && Object.keys(written).length > 0;
};
