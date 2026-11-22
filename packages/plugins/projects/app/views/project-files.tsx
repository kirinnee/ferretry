import { RouteLink } from '@ferretry/app/ui';
import type { ProjectInfo } from '../../contract/index.ts';
import { FileFinder } from '../features/file-finder/file-finder.tsx';
import { seedQuery } from '../features/file-finder/finder-model.ts';
import type { ProjectsClient } from '../lib/client.ts';
import type { FerretRow } from '../lib/ferrets.ts';
import { ferretPath } from '../lib/paths.ts';

/** The address's own `?find=`, read at draw time: "Go to file" in the command bar arrives with the file it named. */
const addressSeed = (): string => seedQuery(globalThis.location?.search ?? '');

/**
 * A project's files (&F6061 U7): the finder over the project's folder, then, when a ferret works there, a way into that
 * ferret's file browser, which is where a file is opened (every read of content is the ferret page's, re-checked there).
 *
 * The finder is keyed by what the address seeded it with, so arriving here again with another `?find=` starts it afresh.
 */
export function ProjectFiles({
  client,
  project,
  ferret,
  daemon,
  onNavigate,
}: {
  readonly client: ProjectsClient;
  readonly project: Pick<ProjectInfo, 'id' | 'path'>;
  /** The newest ferret working in this project, when the ferret list was read and holds one. */
  readonly ferret: FerretRow | null;
  readonly daemon: string;
  readonly onNavigate?: (to: string) => void;
}) {
  const seed = addressSeed();
  return (
    <div className="grid gap-sm" data-project-files={project.id}>
      <FileFinder
        key={`${project.id}|${seed}`}
        client={client}
        project={project}
        initialQuery={seed}
        opensIn={ferret === null ? null : { daemon, ferret }}
        {...(onNavigate === undefined ? {} : { onNavigate })}
      />
      {ferret !== null && (
        <p className="m-0 text-meta text-muted" data-project-files-ferret={ferret.id}>
          A file opens in{' '}
          <RouteLink
            to={ferretPath(daemon, ferret.id)}
            {...(onNavigate === undefined ? {} : { onNavigate })}
            className="w-fit text-accent underline-offset-4 hover:underline"
          >
            the files of {ferret.name}
          </RouteLink>
          , the ferret most recently active here.
        </p>
      )}
    </div>
  );
}
