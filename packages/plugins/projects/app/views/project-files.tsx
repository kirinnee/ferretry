import type { FerretRow } from '../lib/ferrets.ts';
import { ferretPath } from '../lib/paths.ts';
import { RouteLink } from '@ferretry/app/ui';

/**
 * Files remain rooted in a named ferret, never a directory a caller supplied. The files browser itself is the ferret
 * page's (Ferrets/Conversation draw it); a project points at the most recently active ferret's page rather than
 * carrying a second copy of that browser.
 */
export function ProjectFiles({
  daemon,
  ferret,
  onNavigate,
}: {
  readonly daemon: string;
  readonly ferret: FerretRow | null;
  readonly onNavigate?: (to: string) => void;
}) {
  if (ferret === null)
    return (
      <p className="m-0 text-meta leading-base text-faint" data-project-files="unavailable">
        Files are unavailable until this project has a ferret. Ferretry does not browse a project root directly.
      </p>
    );
  return (
    <div className="grid gap-xs" data-project-files={ferret.id}>
      <p className="m-0 text-meta leading-base text-muted">
        Files of most recently active ferret <span className="font-medium text-fg">{ferret.name}</span>.
      </p>
      <RouteLink
        to={ferretPath(daemon, ferret.id)}
        {...(onNavigate === undefined ? {} : { onNavigate })}
        className="w-fit text-meta text-accent underline-offset-4 hover:underline"
      >
        Browse its files
      </RouteLink>
    </div>
  );
}
