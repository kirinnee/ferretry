import type { Word } from '@ferretry/kernel/contract';

/** Browsers' glossary entries (§2.3). */
export const BROWSERS_WORDS = [
  { word: 'page', means: 'one tab a ferret drives', insteadOf: ['tab'] },
  { word: 'take over', means: 'you drive the page yourself for a while', insteadOf: ['hand-off'] },
] as const satisfies readonly Word[];
