/**
 * `@ferretry/plugin-pulls/contract`: pull requests and CI for a project's repositories. The wire shapes every E unit
 * reads, the policy entries and the cache's state file. No shape carries a token.
 */
import type { Word } from '@ferretry/kernel/contract';

export * from './policy.ts';
export * from './state-def.ts';
export * from './wire.ts';

export const PULLS_WORDS: readonly Word[] = [
  { word: 'PR', means: 'a pull request on a connected GitHub repository' },
  { word: 'CI', means: 'the checks and workflow runs GitHub shows for a commit' },
];
