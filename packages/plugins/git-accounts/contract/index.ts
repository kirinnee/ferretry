/**
 * `@ferretry/plugin-git-accounts/contract`: Git accounts a person connects to this machine. GitHub by device flow, the
 * token sealed in this plugin's own document, never returned by any route, command or port.
 */
import type { Word } from '@ferretry/kernel/contract';

export * from './config.ts';
export * from './files.ts';
export * from './gh.ts';
export * from './known-hosts.ts';
export * from './policy.ts';
export * from './port.ts';
export * from './wire.ts';

export const GIT_ACCOUNTS_WORDS: readonly Word[] = [
  { word: 'Git account', means: 'a GitHub login connected to this machine, so ferrets can push and sign as it' },
];
