/**
 * ONE REGISTERED PROJECT, drawn so it reads as something you can open ("i couldn't tell that was a project").
 *
 * A card: an icon, the name as the title, ONE meta line, and two fixed-width actions. The whole face is the link to the
 * project page (the title link's `::after` covers it, see `project-card.css`), so a click anywhere on it opens the
 * project; the buttons sit above the cover. The folder's full path is a tooltip only. "Start a ferret here" opens New
 * ferret with this folder prefilled (`startFerretHref`, S8's one start path), so this card starts nothing itself.
 *
 * Without a project id or a route builder (a suite or a harness frame) the title is plain text and there is no
 * Open; without `daemon` and `onNavigate` there is no start button, because there is nowhere to send it.
 */
import { RouteLink } from '@ferretry/app/ui';
import { Folder, GitBranch } from 'lucide-react';
import type { ProjectInfo } from '../../contract/index.ts';
import { startFerretHref } from '../lib/start-href.ts';

/** `/a/b/` -> `b`; the last folder name of a path, or the path when it has none. */
const lastSegment = (path: string): string => path.replace(/\/+$/u, '').split('/').at(-1) || path;

/** `https://github.com/owner/name(.git)` -> `owner/name`; anything else is the host and path it names. */
const remoteName = (remote: string): string => {
  try {
    const url = new URL(remote);
    return `${url.host === 'github.com' ? '' : `${url.host}/`}${url.pathname.replace(/^\/+|\.git$|\/+$/gu, '')}`;
  } catch {
    return remote;
  }
};

/** The meta line: the repository when one is known, else the folder's name; then the active ferrets when there are any. */
export const projectCardMeta = (project: ProjectInfo, activeFerrets: number): string => {
  const remotes = (project.repos ?? []).flatMap(repo => (repo.remote === undefined ? [] : [repo.remote]));
  const first = remotes.at(0);
  const where =
    first === undefined
      ? lastSegment(project.path)
      : remotes.length > 1
        ? `${remoteName(first)} + ${remotes.length - 1} more`
        : remoteName(first);
  return activeFerrets > 0 ? `${where} · ${activeFerrets} ${activeFerrets === 1 ? 'ferret' : 'ferrets'}` : where;
};

export function ProjectCard({
  project,
  activeFerrets,
  daemon,
  href,
  onNavigate,
}: {
  readonly project: ProjectInfo;
  /** Ferrets working in this project that are not stopped. */
  readonly activeFerrets: number;
  readonly daemon?: string | undefined;
  /** The project page's route, when it can be built. */
  readonly href?: string | undefined;
  readonly onNavigate?: ((to: string) => void) | undefined;
}) {
  const Icon = project.git === undefined && (project.repos ?? []).length === 0 ? Folder : GitBranch;
  const navigate = onNavigate === undefined ? {} : { onNavigate };
  return (
    <li className="fy-pc" data-project-card={project.name} data-registered-project={project.path} title={project.path}>
      <span className="fy-pc__icon" aria-hidden="true">
        <Icon size={20} />
      </span>
      <div className="fy-pc__text">
        <h3 className="fy-pc__title">
          {href === undefined ? (
            project.name
          ) : (
            <RouteLink to={href} {...navigate} className="fy-pc__link">
              {project.name}
            </RouteLink>
          )}
        </h3>
        <p className="fy-pc__meta">{projectCardMeta(project, activeFerrets)}</p>
      </div>
      {href === undefined && (daemon === undefined || onNavigate === undefined) ? null : (
        <div className="fy-pc__actions">
          {href === undefined ? null : (
            <RouteLink to={href} {...navigate} className="kt-btn">
              Open
            </RouteLink>
          )}
          {daemon === undefined || onNavigate === undefined ? null : (
            <button
              className="kt-btn"
              data-variant="primary"
              type="button"
              onClick={() => onNavigate(startFerretHref(daemon, project.path))}
            >
              Start a ferret here
            </button>
          )}
        </div>
      )}
    </li>
  );
}
