import type { Word } from '@ferretry/kernel/contract';

/** Words (§1): the glossary entries this plugin owns (§2.3). */
export const USAGE_WORDS: readonly Word[] = [
  { word: 'spend', means: 'money or tokens a login used', insteadOf: ['cost'] },
  { word: 'budget', means: "your cap on a login's spend" },
  { word: 'pause', means: "Ferretry stopping a login's ferrets at a budget", insteadOf: ['hold (for this)'] },
  { word: 'insight', means: 'a chart over spend and time', insteadOf: ['analytics'] },
];
