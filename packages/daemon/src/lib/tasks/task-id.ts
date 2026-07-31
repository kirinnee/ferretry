import type { TaskId, TaskKind } from '@ferretry/protocol';
import { TaskError } from './task-error.ts';

/** The kind is encoded in the identifier, so a reference like `#F12` is self-describing. */
export const TASK_ID_PREFIX: Readonly<Record<TaskKind, string>> = Object.freeze({
  bug: 'B',
  feature: 'F',
  infra: 'I',
  chore: 'C',
});

const TASK_ID_KIND: Readonly<Record<string, TaskKind>> = Object.freeze({
  B: 'bug',
  F: 'feature',
  I: 'infra',
  C: 'chore',
});

/** The largest ordinal the protocol's id grammar admits (nine digits, no leading zero). */
export const MAX_TASK_ID_NUMBER = 999_999_999;

export interface SplitTaskId {
  readonly kind: TaskKind;
  readonly prefix: string;
  readonly number: number;
}

const TASK_ID_PATTERN = /^([BFIC])([1-9][0-9]{0,8})$/u;

/** Decomposes an identifier, or returns null when it is not one. Never throws on user input. */
export const splitTaskId = (id: string): SplitTaskId | null => {
  const matched = TASK_ID_PATTERN.exec(id.trim());
  if (matched === null) return null;
  const prefix = matched[1] as string;
  return { kind: TASK_ID_KIND[prefix] as TaskKind, prefix, number: Number(matched[2]) };
};

/** Case-insensitive references (`#f12`) resolve to the canonical upper-case id, or to null. */
export const canonicalTaskId = (id: string): TaskId | null => {
  const split = splitTaskId(id.toUpperCase());
  return split === null ? null : (`${split.prefix}${split.number}` as TaskId);
};

/**
 * Allocates the next free identifier for a kind **from the authoritative record set itself**.
 *
 * kteam kept a separate counters file and only consulted the records to raise it. That index is
 * disposable state that can disagree with the board — restore an older counters file, or lose it,
 * and the next allocation collides with a live task. Deriving the ordinal from the records that
 * exist has no such failure mode: the files are the only authority.
 */
export const allocateTaskId = (kind: TaskKind, existingIds: readonly string[]): TaskId => {
  const prefix = TASK_ID_PREFIX[kind];
  let highest = 0;
  for (const candidate of existingIds) {
    const split = splitTaskId(candidate);
    if (split !== null && split.prefix === prefix && split.number > highest) highest = split.number;
  }
  const next = highest + 1;
  if (next > MAX_TASK_ID_NUMBER) {
    throw new TaskError('too-long', `the ${kind} identifier space is exhausted at ${prefix}${highest}`);
  }
  return `${prefix}${next}` as TaskId;
};
