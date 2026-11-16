import type { Word } from '@ferretry/kernel/contract';

/** The plugin id. */
export const PACKS = 'packs' as const;

export const PACKS_WORDS: readonly Word[] = [
  { word: 'recommend', means: "Ferretry's list of models with room to spare" },
];
