import type { SessionView } from '@ferretry/protocol';

/** A deliberately passive projection: task boards are scoped to sessions, not Projects. */
export function ProjectBoards({ sessions }: { readonly sessions: readonly SessionView[] }) {
  if (sessions.length === 0)
    return (
      <p className="m-0 text-meta leading-base text-faint" data-project-boards="empty">
        None of this project’s sessions currently exposes a board.
      </p>
    );
  return (
    <ul className="m-0 grid list-none gap-xs p-0" data-project-boards="ready">
      {sessions.map(session => (
        <li
          className="rounded-control border border-border-strong bg-surface-2 px-control-x py-2"
          key={session.config.id}
        >
          <p className="m-0 text-ui font-medium text-fg">{session.config.name}</p>
          <p className="m-0 mono text-2xs text-muted">
            {session.config.boardAccess} access · {session.config.id}
          </p>
        </li>
      ))}
    </ul>
  );
}
