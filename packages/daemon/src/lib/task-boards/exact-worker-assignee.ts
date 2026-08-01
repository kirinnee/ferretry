import type { Task } from '@ferretry/protocol';
import type { TaskBoardSession } from './types.ts';

/**
 * The three fields resolving an assignee actually needs.
 *
 * NARROWER THAN `TaskBoardSession` deliberately. The rest of that record — the capability hash, the
 * incarnation, the runtime generation — is AUTHORIZATION state, and this function answers a display
 * question: which session does the name a human typed refer to. Demanding the whole record would mean
 * the only directory that fits is the board's own, which omits every session without a capability
 * hash, so a task assigned to a teammate whose session predates the credential would read as unknown.
 * Worse, satisfying the wide type with a projection would mean FABRICATING an authorization field for
 * a display read, and an array of those is one careless call away from an authorization path.
 * `TaskBoardSession` is assignable to this, so the board's own directory still fits.
 */
export type TaskAssigneeCandidate = Pick<TaskBoardSession, 'id' | 'name' | 'teammate'>;

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
