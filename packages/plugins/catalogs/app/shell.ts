/**
 * THE ONE FILE THAT NAMES WHAT THE CATALOGS HALF TAKES FROM OTHER PLUGINS' APP HALVES (§5, §9.6).
 *
 * Today's views imported small helpers from Access (grant sentences, relative words, the paired-device read), from the
 * usage page (a file download), the agenda (a countdown) and the fleet shell (a refusal sentence). A half never imports
 * another plugin's app files, so each is written out here as a stand-in over the shell's own pieces, marked
 * GAP(<owner>) where the owner's app half will publish the real thing.
 */

import { DaemonCallError } from '@ferretry/app';

// ─── Access: the words of a grant refusal ────────────────────────────────────────────────────────────────────────

/** GAP(access): the host command that widens ONE device. `<device>` is a placeholder on purpose: a name is untrusted text. */
export const deviceGrantCommand = (capability: string, axis: 'use' | 'configure', clientName = 'fy'): string =>
  `${clientName} device grant <device> ${capability} --${axis}`;

const GRANT_REFUSALS: Readonly<Record<string, string>> = {
  grant_not_granted: 'not-granted',
  grant_device_not_granted: 'device-not-granted',
  grant_step_up_required: 'step-up-required',
  grant_undetermined: 'undetermined',
  grants_undetermined: 'undetermined',
  grant_forbidden: 'not-granted',
};

export interface GrantRefusalNotice {
  readonly refusal: string;
  readonly detail: string;
}

/** GAP(access): a refusal an ordinary route answered with because of a grant, or `null` when it is about something else. */
export function grantRefusalNotice(error: unknown): GrantRefusalNotice | null {
  if (!(error instanceof DaemonCallError)) return null;
  const refusal = GRANT_REFUSALS[error.code];
  if (refusal === undefined || (error.status !== 403 && error.status !== 503)) return null;
  return { refusal, detail: error.message };
}

/** GAP(access): the id of THIS device (`GET /v1/paired-devices`, Access's) is not read; the command keeps its placeholder. */
export const readThisDeviceId = (): Promise<string | null> => Promise.resolve(null);

// ─── the sentence for a refused change ───────────────────────────────────────────────────────────────────────────

const NO_ANSWER = 'This machine didn’t answer. Check it is awake and try again.';

/** GAP(ferrets): today's `changeRefusalSentence`, over the shell's one error. */
export function changeRefusalSentence(error: unknown): string {
  if (error instanceof DaemonCallError)
    return error.message.trim() === '' ? `This machine refused the change (${String(error.status)}).` : error.message;
  if (error instanceof Error && error.message.trim() !== '') return error.message;
  return NO_ANSWER;
}

// ─── small words and a download ──────────────────────────────────────────────────────────────────────────────────

const plural = (count: number, word: string): string => `${String(count)} ${word}${count === 1 ? '' : 's'} ago`;

/** How long ago an instant was, in words ("just now", "5 minutes ago", "yesterday"). Copied from Access's security log. */
export function relativeWords(at: string, nowMs: number): string {
  const instant = Date.parse(at);
  if (!Number.isFinite(instant)) return 'at an unknown time';
  const seconds = Math.max(0, Math.round((nowMs - instant) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return plural(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (hours < 24) return plural(hours, 'hour');
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : plural(days, 'day');
}

/** A short "3m ago" for a crowded line. Copied from the agenda's revisions. */
export const shortAgo = (at: string, now: number): string => {
  const then = Date.parse(at);
  if (!Number.isFinite(then)) return '';
  const minutes = Math.max(0, Math.floor((now - then) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  return `${String(Math.floor(hours / 24))}d ago`;
};

/** Whole seconds until a deadline; never below zero. Copied from the agenda's undo toast. */
export const secondsLeft = (deadline: number, now: number): number => Math.max(0, Math.ceil((deadline - now) / 1000));

/** Hands a finished file to the person. */
export type SaveText = (fileName: string, text: string) => void;

/** The browser's own download: an object URL on a link that is clicked once, then let go. Copied from the usage page. */
export const downloadText: SaveText = (fileName, text) => {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
};

/** The device id Access mints, as a command line may carry it. */
const PAIRED_DEVICE_ID = /^fy_device_id_[A-Za-z0-9_-]{22}$/u;
export const PairedDeviceIdSchema = {
  safeParse: (value: unknown): { readonly success: boolean } => ({
    success: typeof value === 'string' && PAIRED_DEVICE_ID.test(value),
  }),
};
