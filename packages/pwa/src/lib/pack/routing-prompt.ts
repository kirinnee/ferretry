/**
 * THE ROUTING PROMPT CARD'S WORDS (docs/pack-mode.md): where the prompt in effect came from, why Save
 * or Clean up cannot run on what is typed, and how a model usable now is described — so the card says
 * them one way and a test can read them without a DOM.
 *
 * Pure: values in, sentences out.
 */

import {
  DAEMON_FEATURES,
  LEGACY_MAX_IDEA_CHARS,
  MAX_IDEA_CHARS,
  MAX_ROUGH_PROMPT_CHARS,
  MAX_ROUTING_PROMPT_CHARS,
  type PackCleanUpStatus,
  type PackQuotaState,
  type RoutingPromptView,
} from '@ferretry/protocol';
import type { BadgeTone } from '../../shell/primitives.tsx';
import { type DaemonHealthRead, machineLacks, machineOffers } from '../daemon-health.ts';
import { UPDATE_MACHINE_WHERE } from '../machine-update-words.ts';

const count = (value: number): string => value.toLocaleString('en-US');

/** The prompt's origin in one line: the owner's words, an accepted clean-up or write-up, or the catalogs' default. */
export function routingSourceWords(routing: RoutingPromptView, date: (instant: string) => string): string {
  if (routing.source === 'default') return 'Default — built from the model catalogs';
  const suggested = routing.suggested;
  if (suggested === undefined) return 'Your words';
  return `${suggested.mode === 'generate' ? 'Written' : 'Cleaned up'} by ${suggested.by} via ${suggested.via}, accepted ${date(suggested.acceptedAt)}`;
}

/** The counter under the text area: characters typed against what a saved prompt may hold. */
export const routingCounter = (text: string): string =>
  `${count(text.trim().length)} / ${count(MAX_ROUTING_PROMPT_CHARS)}`;

/**
 * How much "your idea" may say on THIS machine, and the note that explains a shorter limit.
 *
 * The app ships before the daemon, so the raised 4,000 is only offered once the machine lists
 * `pack.idea.4000`; until then the field keeps the 500 the machine still refuses past. The note is said
 * only when the machine ANSWERED and lacks the feature — a read still going, or one that failed, keeps
 * the shorter limit quietly rather than telling an owner to update a machine it could not question.
 */
export interface IdeaLimit {
  readonly max: number;
  readonly updateNote: string | null;
}

/** The limit when nothing gates it: the one constant the route, the CLI and the app share. */
export const FULL_IDEA_LIMIT: IdeaLimit = { max: MAX_IDEA_CHARS, updateNote: null };

export function ideaLimitFor(machine: DaemonHealthRead): IdeaLimit {
  if (machineOffers(machine, DAEMON_FEATURES.packIdea4000)) return FULL_IDEA_LIMIT;
  return {
    max: LEGACY_MAX_IDEA_CHARS,
    updateNote: machineLacks(machine, DAEMON_FEATURES.packIdea4000)
      ? `This machine needs an update for ideas longer than ${count(LEGACY_MAX_IDEA_CHARS)} characters — ${UPDATE_MACHINE_WHERE}.`
      : null,
  };
}

/** The idea field's counter: characters typed against what Write it for me takes. */
export const ideaCounter = (text: string, limit: IdeaLimit = FULL_IDEA_LIMIT): string =>
  `${count(text.length)} / ${count(limit.max)}`;

/** How full the idea field is: `near` from nine tenths of the limit, `full` at it. */
export function ideaFill(text: string, limit: IdeaLimit = FULL_IDEA_LIMIT): 'ok' | 'near' | 'full' {
  if (text.length >= limit.max) return 'full';
  return text.length >= limit.max * 0.9 ? 'near' : 'ok';
}

/** Why the typed text cannot be saved as it is, or `null` when it can. Blank saves: it removes the prompt. */
export function routingSaveProblem(text: string): string | null {
  const length = text.trim().length;
  if (length <= MAX_ROUTING_PROMPT_CHARS) return null;
  return `Too long to save: ${count(length)} characters, and a routing prompt holds ${count(MAX_ROUTING_PROMPT_CHARS)}. Shorten it, or press Clean up — it takes up to ${count(MAX_ROUGH_PROMPT_CHARS)}.`;
}

/** Why Clean up cannot start on the typed text now, or `null` when it can. */
export function cleanUpProblem(text: string, status: PackCleanUpStatus, running: boolean): string | null {
  if (!status.available) return status.reason ?? 'This machine cannot clean up a prompt now.';
  if (running) return 'A clean-up is already running.';
  const length = text.trim().length;
  if (length > MAX_ROUGH_PROMPT_CHARS)
    return `Clean up takes at most ${count(MAX_ROUGH_PROMPT_CHARS)} characters; this is ${count(length)}.`;
  return null;
}

/** Why Write it for me cannot start now, or `null` when it can. */
export function writeProblem(status: PackCleanUpStatus, running: boolean): string | null {
  if (!status.available) return status.reason ?? 'This machine cannot write a prompt now.';
  if (running) return 'A prompt is already being written.';
  return null;
}

/** `1st`, `2nd`, `3rd`, `4th`, `11th`, `21st`: where the routing prompt names a model. */
export function ordinal(position: number): string {
  const tens = position % 100;
  if (tens >= 11 && tens <= 13) return `${position}th`;
  const suffix = ({ 1: 'st', 2: 'nd', 3: 'rd' } as Readonly<Record<number, string>>)[position % 10] ?? 'th';
  return `${position}${suffix}`;
}

/** A quota band as a chip: a tone and a word, so colour is never the only signal. */
export const QUOTA_CHIP: Readonly<Record<PackQuotaState, { readonly tone: BadgeTone; readonly label: string }>> = {
  plenty: { tone: 'ok', label: 'Plenty of quota' },
  some: { tone: 'accent', label: 'Some quota' },
  low: { tone: 'warn', label: 'Low quota' },
  exhausted: { tone: 'err', label: 'Out of quota' },
  unknown: { tone: 'pend', label: 'Quota not measured' },
};
