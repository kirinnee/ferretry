import type { Word } from '@ferretry/kernel/contract';

/** Terminals' glossary entries (§2.3). */
export const TERMINALS_WORDS = [
  { word: 'terminal', means: 'a shell a ferret or you can type into', insteadOf: ['pane', 'tty'] },
  { word: 'runner', means: "where a ferret's process runs" },
] as const satisfies readonly Word[];
