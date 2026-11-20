/**
 * The Warden's first-run page, worked out without a browser: the three answers, what each one writes to `warden.yaml`,
 * which answer a machine's settings already spell, and whether `warden.yaml` is already on the machine.
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
    line: 'Free. Flags stuck ferrets.',
  },
  {
    id: 'jev',
    title: '+ Jev',
    line: 'Cheap AI check. $0.50 a day.',
  },
  {
    id: 'llm',
    title: '+ LLM investigation',
    line: 'AI look at the rest. $2 a day.',
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

/**
 * What `GET /v1/config/file` says about `warden.yaml` that this page needs: whether the file is on the machine. (The
 * route also returns the text and a state; the page never reads either, so nothing in them can reach a card.)
 */
export interface WardenFileRead {
  readonly exists: boolean;
}

/**
 * Whether `warden.yaml` is already on the machine. A file that exists was written by somebody, a hand edit or an earlier
 * answer, and it may say `enabled: false` on purpose, so the page never offers to write over it.
 */
export const wardenFileExists = (read: WardenFileRead): boolean => read.exists;
