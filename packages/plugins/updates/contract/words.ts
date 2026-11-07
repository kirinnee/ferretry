import type { Word } from '@ferretry/kernel/contract';

/** Updates' glossary entries (§2.3). */
export const UPDATES_WORDS = [
  { word: 'update', means: 'moving a daemon to a newer release', insteadOf: ['upgrade'] },
  { word: 'behind', means: 'a daemon older than the app', insteadOf: ['out of date', 'skew'] },
] as const satisfies readonly Word[];
