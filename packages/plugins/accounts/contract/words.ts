import type { Word } from '@ferretry/kernel/contract';

/** Accounts' glossary entries (§2.3). */
export const ACCOUNTS_WORDS = [
  { word: 'account', means: 'your account on a website', insteadOf: ['site account'] },
  { word: 'sign-in', means: 'one way into an account, at one place', insteadOf: ['login'] },
  { word: 'rule', means: 'your standing yes for one sign-in', insteadOf: ['pre-approval'] },
  { word: 'recipe', means: 'how a sign-in works, written down', insteadOf: ['playbook'] },
] as const satisfies readonly Word[];
