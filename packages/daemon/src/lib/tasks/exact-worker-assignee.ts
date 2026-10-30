import type { Task } from '@ferretry/protocol';

/** The three fields resolving an assignee reads: a display question, with no authorization state in it. */
export interface TaskAssigneeCandidate {
  readonly id: string;
  readonly name: string | null;
  readonly teammate?: string | null | undefined;
}

/**
 * The session an assignee names, or `null` when nothing does — or when more than one thing does.
 *
 * An exact session id wins outright. Failing that, a teammate CALLSIGN matches, and a display name
 * matches only for a session with no callsign of its own — a session answering to `ossy` must not be
 * reachable through someone else's display name. Ambiguity resolves to `null` rather than to the
 * first match: two sessions answering to one name is a fact the reader should see as "unknown", not a
 * coin flip that attributes a task to whichever one the index happened to list first.
 */
export function exactWorkerAssignee(
  task: Pick<Task, 'assignee'>,
  sessions: readonly TaskAssigneeCandidate[],
): string | null {
  const assignee = task.assignee?.trim();
  if (!assignee) return null;

  const exact = sessions.find(session => session.id === assignee);
  if (exact !== undefined) return exact.id;

  const named = sessions.filter(session => {
    const teammate = session.teammate?.trim();
    const name = session.name?.trim();
    return (
      teammate === assignee || ((teammate === null || teammate === undefined || teammate === '') && name === assignee)
    );
  });
  return named.length === 1 ? (named[0]?.id ?? null) : null;
}
