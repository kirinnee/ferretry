import { codexVerification } from './update/index.ts';

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

/** The file name Codex files a rollout under: `sessions/YYYY/MM/DD/rollout-YYYY-MM-DDTHH-MM-SS-<id>.jsonl`. */
export function rolloutName(id: string, now: Date): string {
  const stamp = now.toISOString().slice(0, 19).replaceAll(':', '-');
  return `sessions/${stamp.slice(0, 4)}/${stamp.slice(5, 7)}/${stamp.slice(8, 10)}/rollout-${stamp}-${id}.jsonl`;
}

type RolloutRecord = { type?: unknown; payload?: { type?: unknown; id?: unknown; cli_version?: unknown } & object };

/**
 * Cuts a rollout at the end of turn `at.turn` (a turn is one `user_message` and everything up to the next one; absent: the
 * whole conversation) into the text of a NEW rollout. Pure: the source text is read, never changed.
 *
 * The rollout format is versioned, so a rollout is cut only when its header names a Codex version Ferretry verified or an
 * older one (`codexVerification`): a newer writer may have changed the records, and a cut of an unseen format could split
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
  const records: RolloutRecord[] = [];
  for (const [index, line] of lines.entries()) {
    try {
      records.push(JSON.parse(line) as RolloutRecord);
    } catch {
      return refused(`line ${index + 1} of the conversation is not a record, so it cannot be cut safely`);
    }
  }
  const headerAt = records.findIndex(record => record.type === 'session_meta');
  const header = records[headerAt];
  if (header === undefined || headerAt > 7 || typeof header.payload?.id !== 'string')
    return refused('the conversation has no header Ferretry knows how to read, so it cannot be forked');
  const version = header.payload.cli_version;
  const standing = typeof version === 'string' ? codexVerification(version) : 'unknown';
  if (standing !== 'verified' && standing !== 'older')
    return refused(
      `the conversation was written by Codex ${typeof version === 'string' ? version : '(unknown version)'}, a rollout format Ferretry has not tested, so it was not forked`,
    );

  const starts = records.flatMap((record, index) =>
    record.type === 'event_msg' && record.payload?.type === 'user_message' ? [index] : [],
  );
  let end = records.length;
  if (at !== undefined) {
    if (!Number.isInteger(at.turn) || at.turn < 1 || at.turn > starts.length)
      return refused(`turn ${at.turn} is not in this conversation, which has ${starts.length}`);
    end = starts[at.turn] ?? records.length;
    if (at.entry !== undefined) {
      const named = /^(.+):(\d+):\d+:[a-z]+$/u.exec(at.entry);
      const line = named?.[1] === header.payload.id ? Number(named[2]) : 0;
      if (line < (starts[at.turn - 1] ?? 0) + 1 || line > end)
        return refused(`the entry ${at.entry} is not in turn ${at.turn} of this conversation`);
    }
  }

  const neutral = `${forked.marker.slice(0, forked.marker.lastIndexOf('/'))}/forked`;
  const rewritten = { ...header, payload: { ...header.payload, id: forked.id, cwd: forked.folder } };
  const kept = lines.slice(0, end).map((line, index) => (index === headerAt ? JSON.stringify(rewritten) : line));
  return {
    kind: 'cut',
    text: `${kept.join('\n').split(forked.marker).join(neutral)}\n`,
    turns: at?.turn ?? starts.length,
  };
}
