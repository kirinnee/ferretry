/**
 * How a login reads on the Runtimes screens: the smallest local copy of the words Logins' own screens use for it
 * (cross-plugin imports go through contracts only, and a login's wire shape is `LoginView`).
 */

import type { HarnessKey } from '@ferretry/core-ferrets/contract';
import type { LoginView } from '@ferretry/plugin-logins/contract';
import { harnessName, harnessWords, supportedHarnessKeys } from '../../contract/harness-words.ts';

export type HarnessKind = HarnessKey;

/** The harnesses Runtimes has behaviour for: the ones its screens offer. */
export const HARNESSES: readonly HarnessKind[] = supportedHarnessKeys();

/** The short name used in "Claude settings will be skipped on Codex". */
const harnessShort = (harness: HarnessKind): string => harnessWords(harness)?.short ?? harness;

/** The words for what a harness skips: the short names of the other harnesses Runtimes runs ("Claude"; "Claude and Codex"). */
export const otherHarnessesShort = (harness: HarnessKind): string =>
  HARNESSES.filter(other => other !== harness)
    .map(harnessShort)
    .join(' and ');

/** Every CLI a login drives, Claude Code first: both for an environment login with a `claude-code:` and a `codex:` half, else its one. */
export const credentialHarnesses = (credential: LoginView): readonly HarnessKind[] => credential.harnesses;

/** "Claude Code", or "Claude Code + Codex" for a login that drives both. */
export const harnessesName = (harnesses: readonly HarnessKind[]): string =>
  harnesses.map(harness => harnessName(harness)).join(' + ');

export const plural = (count: number, one: string, many = `${one}s`): string =>
  `${String(count)} ${count === 1 ? one : many}`;

/** "you@example.com", or "Claude Code login" when the harness has not told us the email yet. */
export const credentialEmail = (credential: LoginView): string =>
  credential.email ?? `${harnessesName(credentialHarnesses(credential))} login`;
