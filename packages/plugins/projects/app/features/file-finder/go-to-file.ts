/**
 * "GO TO FILE" IN THE COMMAND BAR (&F6061 U7), for the project the reader is on.
 *
 * It is offered only on a project's own page (`/d/<daemon>/projects/<id>`): "the current project" is the one whose address
 * is on screen, so there is no folder to pick and nothing to remember. Typing searches that project's file index on the
 * daemon (the same route as the page's finder) and lists the best few matches; choosing one opens the project page with
 * its finder seeded with that path (`?find=`), where the path can be copied and the ferret's browser is one link away.
 *
 * The bar asks its sources on every keystroke and cannot wait, so this one follows the shape the Ferrets source uses: it
 * answers what it holds, reads the rest once the typing pauses and asks the bar to list again (`changed`). While a read is
 * out it says so (`pending`) rather than listing the previous text's files under the new text.
 */
import type { PluginCommandContext } from '@ferretry/app';
import type { CommandBarEntry, CommandBarSource } from '@ferretry/app/ui';
import { isProjectId, projectPath } from '../../lib/paths.ts';
import { findFiles } from './finder-api.ts';
import { searchText, splitPath } from './finder-model.ts';

/** How many matches the bar asks for: it shows at most eight a group and re-ranks what it is given. */
const BAR_MATCHES = 12;
/** Wait for a typed burst to stop before asking the daemon. */
const BAR_DEBOUNCE_MS = 150;

/** The group the files are listed under. */
const FILES_GROUP = 'Files';

/**
 * The project a pathname is, on this daemon, or `undefined`. A project is entered only through its daemon's own address
 * and its registered UUID, so anything else (another daemon's page, a typed folder) is not "the current project".
 */
export const currentProjectId = (pathname: string, daemon: string): string | undefined => {
  const match = /^\/d\/([^/]+)\/projects\/([^/]+)\/?$/u.exec(pathname);
  if (match === null) return undefined;
  try {
    const [, rawDaemon, rawProject] = match as unknown as [string, string, string];
    const id = decodeURIComponent(rawProject);
    return decodeURIComponent(rawDaemon) === daemon && isProjectId(id) ? id : undefined;
  } catch {
    return undefined;
  }
};

/** One read the source has made or is making: which project, which text, and what came back. */
interface Held {
  readonly projectId: string;
  readonly query: string;
  /** The paths that came back (none when the read failed); absent while it is out. */
  paths?: readonly string[];
}

export interface GoToFileOptions {
  /** The browser's pathname right now. Default: the window's. */
  readonly pathname?: () => string;
  readonly debounceMs?: number;
}

export const goToFileSource =
  (options: GoToFileOptions = {}) =>
  (context: PluginCommandContext): CommandBarSource => {
    const pathname = options.pathname ?? (() => globalThis.location?.pathname ?? '');
    const debounceMs = options.debounceMs ?? BAR_DEBOUNCE_MS;
    let held: Held | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: AbortController | undefined;

    const ask = (next: Held): void => {
      clearTimeout(timer);
      abort?.abort();
      held = next;
      const controller = new AbortController();
      abort = controller;
      timer = setTimeout(() => {
        void findFiles(context.client, next.projectId, next.query, BAR_MATCHES, controller.signal).then(
          answer => {
            if (controller.signal.aborted) return;
            next.paths = answer.files.map(file => file.path);
            context.changed();
          },
          () => {
            // A failed read lists no files; the bar's places stand regardless.
            if (controller.signal.aborted) return;
            next.paths = [];
            context.changed();
          },
        );
      }, debounceMs);
    };

    const fileEntry = (projectId: string, path: string, rank: number): CommandBarEntry => {
      const { folder, name } = splitPath(path);
      return {
        id: `file-${projectId}-${path}`,
        group: FILES_GROUP,
        label: name,
        description: folder === '' ? 'Top of the project' : folder,
        keywords: [path],
        order: rank,
        run: () => context.navigate(`${projectPath(context.daemon, projectId)}?find=${encodeURIComponent(path)}`),
      };
    };

    return {
      list: raw => {
        const projectId = currentProjectId(pathname(), context.daemon);
        if (projectId === undefined) return [];
        const query = searchText(raw);
        if (query === '')
          return [
            {
              id: 'go-to-file',
              group: 'Go to',
              label: 'Go to file',
              description: 'Search this project’s files by name or path',
              keywords: ['file', 'find', 'open', 'search', 'project'],
              resting: true,
              order: 36,
              run: () => context.navigate(projectPath(context.daemon, projectId)),
            },
          ];
        if (held?.projectId !== projectId || held.query !== query) ask({ projectId, query });
        const paths = held?.paths;
        if (paths === undefined) return { entries: [], pending: 'Searching this project’s files…' };
        return paths.map((path, rank) => fileEntry(projectId, path, rank));
      },
    };
  };
