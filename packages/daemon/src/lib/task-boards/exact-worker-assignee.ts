import type { Task } from '@ferretry/protocol';
import type { TaskBoardSession } from './types.ts';

export function exactWorkerAssignee(
  task: Pick<Task, 'assignee'>,
  sessions: readonly TaskBoardSession[],
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
