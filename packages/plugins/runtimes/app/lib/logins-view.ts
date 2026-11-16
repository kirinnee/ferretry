/**
 * How a login reads on the Runtimes screens: the smallest local copy of the words Logins' own screens use for it
 * (cross-plugin imports go through contracts only, and a login's wire shape is `LoginView`).
 */

import type { HarnessKey } from '@ferretry/core-ferrets/contract';
import type { LoginView } from '@ferretry/plugin-logins/contract';
import { HARNESS_NAMES } from './shell-ports.ts';

export type HarnessKind = HarnessKey;

export const HARNESSES: readonly HarnessKind[] = ['claude-code', 'codex'];

/** The short names used in "Claude settings will be skipped on Codex". */
export const HARNESS_SHORT: Readonly<Record<HarnessKind, string>> = { 'claude-code': 'Claude', codex: 'Codex' };

export const otherHarness = (harness: HarnessKind): HarnessKind =>
  harness === 'claude-code' ? 'codex' : 'claude-code';

/** Every CLI a login drives, Claude Code first: both for an environment login with a `claude-code:` and a `codex:` half, else its one. */
export const credentialHarnesses = (credential: LoginView): readonly HarnessKind[] => credential.harnesses;

/** A scope as the chip says it: one CLI, or `both`. */
export type LoginScope = HarnessKind | 'both';

/** Which CLIs a list of harnesses covers, as one scope. An empty list cannot happen; it reads as Claude. */
export const scopeOfHarnesses = (harnesses: readonly HarnessKind[]): LoginScope =>
  harnesses.includes('claude-code') && harnesses.includes('codex') ? 'both' : (harnesses[0] ?? 'claude-code');

/** The scope chip's words. */
export const LOGIN_SCOPE_WORDS: Readonly<Record<LoginScope, string>> = {
  'claude-code': 'Claude only',
  codex: 'Codex only',
  both: 'Claude + Codex',
};

/** "Claude Code", or "Claude Code + Codex" for a login that drives both. */
export const harnessesName = (harnesses: readonly HarnessKind[]): string =>
  harnesses.map(harness => HARNESS_NAMES[harness]).join(' + ');

export const plural = (count: number, one: string, many = `${one}s`): string =>
  `${String(count)} ${count === 1 ? one : many}`;

/** "you@example.com", or "Claude Code login" when the harness has not told us the email yet. */
export const credentialEmail = (credential: LoginView): string =>
  credential.email ?? `${harnessesName(credentialHarnesses(credential))} login`;
