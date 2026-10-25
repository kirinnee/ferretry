/**
 * A `400 invalid_request` SAID IN PLAIN WORDS, and the reason it most likely happened.
 *
 * The daemon refuses a request body its schema does not accept with `the request body is invalid — idea:
 * Too big: expected string to have <=500 characters`: accurate, and no use to a person. When the app is
 * NEWER than the machine, that refusal is usually not a mistake at all — the app raised a limit or sent a
 * field the machine's version has never heard of, because the app deploys before the daemon does. So the
 * known field limits are said as a sentence, the refusal names the likelier cause when the two versions
 * show it, and the daemon's own text is kept for a Details disclosure rather than thrown away.
 *
 * Pure: an error and a version in, words out. An error that is not this refusal answers `undefined`, so
 * every other failure keeps whatever its caller already says.
 */

import { compareProtocolVersions } from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import { UPDATE_MACHINE_WHERE } from './machine-update-words.ts';

export interface RefusalWords {
  readonly sentence: string;
  /** The daemon's own text, for a Details disclosure; absent when the sentence already is it. */
  readonly details?: string;
}

/** What each field a person fills in is called. A field not named here is quoted as the daemon spelled it. */
const FIELD_LABELS: Readonly<Record<string, string>> = {
  idea: 'Your idea',
  prompt: 'The prompt',
};

const COUNT = (value: string): string => Number(value).toLocaleString('en-US');

/** One issue (`idea: Too big: expected string to have <=500 characters`) as a sentence, or `undefined` if unknown. */
function issueSentence(issue: string): string | undefined {
  const split = issue.indexOf(': ');
  if (split <= 0) return undefined;
  const field = issue.slice(0, split);
  const label = FIELD_LABELS[field];
  if (label === undefined) return undefined;
  const problem = issue.slice(split + 2);
  const tooBig = /^Too big: expected string to have <=(\d+) characters$/u.exec(problem);
  if (tooBig?.[1] !== undefined) return `${label} can hold at most ${COUNT(tooBig[1])} characters on this machine.`;
  const tooSmall = /^Too small: expected string to have >=(\d+) characters?$/u.exec(problem);
  if (tooSmall?.[1] === '1') return `${label} can’t be empty.`;
  if (tooSmall?.[1] !== undefined) return `${label} needs at least ${COUNT(tooSmall[1])} characters.`;
  return undefined;
}

/** The sentence added when the app is newer than the machine that refused it. */
const olderMachine = (daemonVersion: string, appVersion: string): string =>
  `Your machine may be on an older version (it runs ${daemonVersion}; this app is ${appVersion}) — ${UPDATE_MACHINE_WHERE}.`;

export function invalidRequestWords(error: unknown, appVersion: string | undefined): RefusalWords | undefined {
  if (!(error instanceof FyHttpError) || error.status !== 400 || error.code !== 'invalid_request') return undefined;
  const marker = error.message.indexOf(' — ');
  const issues = (marker < 0 ? '' : error.message.slice(marker + 3)).split('; ').filter(issue => issue !== '');
  const sentences = issues.map(issueSentence);
  const known = sentences.length > 0 && sentences.every(sentence => sentence !== undefined);
  const older =
    appVersion !== undefined &&
    error.daemonVersion !== undefined &&
    compareProtocolVersions(appVersion, error.daemonVersion) === 1
      ? olderMachine(error.daemonVersion, appVersion)
      : undefined;
  if (!known) return older === undefined ? undefined : { sentence: `${error.message}. ${older}` };
  const said = sentences.filter((sentence): sentence is string => sentence !== undefined).join(' ');
  return { sentence: older === undefined ? said : `${said} ${older}`, details: error.message };
}
