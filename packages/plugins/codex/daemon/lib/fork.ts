import {
  beforeNextTask,
  dependsOnSubagent,
  forkRecord,
  incompleteCut,
  object,
  startsTurn,
  type ForkRecord,
} from './fork-records.ts';

/** What a fork of a rollout needs to know about the conversation it makes. */
export interface ForkedRollout {
  /** The new conversation's id: the one `codex resume` is given. */
  readonly id: string;
  /** Where the new ferret works; the header names it, as Codex does for the folder a conversation was started in. */
  readonly folder: string;
  /** The source home's correlation path: the copy must not carry it, or the source's own proof would find two rollouts. */
  readonly marker: string;
}

export type RolloutCut =
  | { readonly kind: 'cut'; readonly text: string; readonly turns: number }
  | { readonly kind: 'refused'; readonly reason: string };

const refused = (reason: string): RolloutCut => ({ kind: 'refused', reason });

/** Each writer was exercised by tests/realworld/fork-resume.test.ts with synthetic history and a loopback model. */
const TESTED_ROLLOUT_WRITERS = new Set(['0.145.0', '0.166.0', '0.170.0']);

/** The file name Codex files a rollout under: `sessions/YYYY/MM/DD/rollout-YYYY-MM-DDTHH-MM-SS-<id>.jsonl`. */
export function rolloutName(id: string, now: Date): string {
  const stamp = now.toISOString().slice(0, 19).replaceAll(':', '-');
  return `sessions/${stamp.slice(0, 4)}/${stamp.slice(5, 7)}/${stamp.slice(8, 10)}/rollout-${stamp}-${id}.jsonl`;
}

/**
 * Cuts a rollout at the end of turn `at.turn` (one canonical user response_item and its completed answer; absent: the
 * whole conversation) into the text of a NEW rollout. Pure: the source text is read, never changed.
 *
 * The rollout format is versioned, so a rollout is cut only for the explicitly tested writers. Other writers may
 * have changed the records, and a cut of an unseen format could split
 * what belongs together. A line that is not a record is not guessed at either: it refuses the whole cut. The unflushed last
 * line (no newline yet) is not part of the cut, as no reader takes it.
 */
export function cutRollout(
  source: string,
  at: { readonly turn: number; readonly entry?: string } | undefined,
  forked: ForkedRollout,
): RolloutCut {
  const lines = source.split('\n');
  lines.pop();
  const records: ForkRecord[] = [];
  for (const [index, line] of lines.entries()) {
    try {
      const value = object(JSON.parse(line));
      if (typeof value?.type !== 'string' || object(value.payload) === undefined) throw new Error('not a record');
      records.push(value as ForkRecord);
    } catch {
      return refused(`line ${index + 1} of the conversation is not a record, so it cannot be cut safely`);
    }
  }
  const headerAt = records.findIndex(record => record.type === 'session_meta');
  const header = records[headerAt];
  if (header === undefined || headerAt > 7 || typeof header.payload?.id !== 'string')
    return refused('the conversation has no header Ferretry knows how to read, so it cannot be forked');
  const version = header.payload.cli_version;
  if (typeof version !== 'string' || !TESTED_ROLLOUT_WRITERS.has(version))
    return refused(
      `the conversation was written by Codex ${typeof version === 'string' ? version : '(unknown version)'}, a rollout format Ferretry has not tested, so it was not forked`,
    );

  const starts = records.flatMap((record, index) => (startsTurn(record) ? [index] : []));
  let end = records.length;
  if (at !== undefined) {
    if (!Number.isInteger(at.turn) || at.turn < 1 || at.turn > starts.length)
      return refused(`turn ${at.turn} is not in this conversation, which has ${starts.length}`);
    const next = starts[at.turn];
    end = next === undefined ? records.length : beforeNextTask(records, starts[at.turn - 1] ?? 0, next);
    if (at.entry !== undefined) {
      const named = /^(.+):(\d+):\d+:[a-z]+$/u.exec(at.entry);
      const line = named?.[1] === header.payload.id ? Number(named[2]) : 0;
      if (line < (starts[at.turn - 1] ?? 0) + 1 || line > end)
        return refused(`the entry ${at.entry} is not in turn ${at.turn} of this conversation`);
    }
  }

  const selected = records.slice(0, end);
  if (dependsOnSubagent(selected))
    return refused(
      'this cut includes a native subagent whose separate rollout cannot be copied safely; pick a cut before it',
    );
  const incomplete = incompleteCut(selected);
  if (incomplete !== undefined) return refused(incomplete);
  const neutral = `${forked.marker.slice(0, forked.marker.lastIndexOf('/'))}/forked`;
  const kept = selected.map(record =>
    JSON.stringify(
      forkRecord(
        record,
        header.payload.id as string,
        typeof header.payload.cwd === 'string' ? header.payload.cwd : '',
        forked.id,
        forked.folder,
      ),
    ),
  );
  return {
    kind: 'cut',
    text: `${kept.join('\n').split(forked.marker).join(neutral)}\n`,
    turns: at?.turn ?? starts.length,
  };
}
