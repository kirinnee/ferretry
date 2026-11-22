/**
 * "GO TO FILE" IN THE COMMAND BAR (&F6061 U7), for the project the reader is on.
 *
 * It is offered only on a project's own page (`/d/<daemon>/projects/<id>`): "the current project" is the one whose address
 * is on screen, so there is no folder to pick and nothing to remember. Typing searches that project's file index on the
 * daemon (the same route as the page's finder) and lists the best few matches. Choosing one OPENS THAT FILE in the file
 * view of the ferret most recently active in the project (the ferret page's own gated read, `?file=`); with no ferret
 * working there it opens the project page with its finder seeded with the path (`?find=`), where the path can be copied.
 *
 * The bar asks its sources on every keystroke and cannot wait, so this one follows the shape the Ferrets source uses: it
 * answers what it holds, reads the rest once the typing pauses and asks the bar to list again (`changed`). While a read is
 * out it says so (`pending`) rather than listing the previous text's files under the new text.
 *
 * A READ THAT FAILS IS SAID, NOT DROPPED. A refusal (403: the grant is off, or the passkey step-up is not done) or an
 * unavailable index (503) would otherwise read as "no results", which tells the reader the file is not there. It is listed
 * as one line (its label says what happened, its description is the daemon's own sentence), and it is NOT kept: the same text asked again later (the bar
 * closed and reopened, or a few seconds on) reads again, so granting access and retyping works without a reload.
 */
import type { PluginCommandContext } from '@ferretry/app';
import type { CommandBarEntry, CommandBarSource } from '@ferretry/app/ui';
import { fetchProjects } from '../../lib/projects-api.ts';
import { reasonOf } from '../../lib/client.ts';
import { projectFerrets, readFerrets } from '../../lib/ferrets.ts';
import { ferretFilePath, isProjectId, projectPath } from '../../lib/paths.ts';
import { findFiles, isRefusal, statusOf } from './finder-api.ts';
import { searchText, splitPath } from './finder-model.ts';

/** How many matches the bar asks for: it shows at most eight a group and re-ranks what it is given. */
const BAR_MATCHES = 12;
/** Wait for a typed burst to stop before asking the daemon. */
const BAR_DEBOUNCE_MS = 150;
/** A failed read is asked again once it is this old, when the same text is listed again. */
const BAR_RETRY_MS = 4_000;

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

/**
 * A piece of text as letters, digits and `_` only, with no two texts alike. The bar turns an entry id into a DOM id by
 * replacing every other character with `-`, so `src/entry.ts` and `src/entry-ts` would become ONE id (and
 * `aria-activedescendant` would name the wrong row). Here every other character is written as `_<hex>_`, and a `_` itself
 * too, so the id is already what the bar would make of it and the result cannot collide.
 */
const idSafe = (text: string): string =>
  text.replaceAll(/[^A-Za-z0-9]/gu, character => `_${(character.codePointAt(0) ?? 0).toString(16)}_`);

/** The entry id of one project's file. Its two parts are separated by `-`, which {@link idSafe} never writes. */
export const fileEntryId = (projectId: string, path: string): string => `file-${idSafe(projectId)}-${idSafe(path)}`;

/** One read the source has made or is making: which project, which text, and what came back. */
interface Held {
  readonly projectId: string;
  readonly query: string;
  /** The paths that came back; absent while the read is out or after it failed. */
  paths?: readonly string[];
  /** The daemon's sentence when the read failed, and when. */
  failure?: { readonly reason: string; readonly at: number; readonly refused: boolean; readonly unavailable: boolean };
}

export interface GoToFileOptions {
  /** The browser's pathname right now. Default: the window's. */
  readonly pathname?: () => string;
  readonly debounceMs?: number;
  /** The clock a failed read's age is told by. */
  readonly now?: () => number;
  readonly retryMs?: number;
}

export const goToFileSource =
  (options: GoToFileOptions = {}) =>
  (context: PluginCommandContext): CommandBarSource => {
    const pathname = options.pathname ?? (() => globalThis.location?.pathname ?? '');
    const debounceMs = options.debounceMs ?? BAR_DEBOUNCE_MS;
    const now = options.now ?? Date.now;
    const retryMs = options.retryMs ?? BAR_RETRY_MS;
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
          (cause: unknown) => {
            if (controller.signal.aborted) return;
            next.failure = {
              reason: reasonOf(cause),
              at: now(),
              refused: isRefusal(cause),
              unavailable: statusOf(cause) === 503,
            };
            context.changed();
          },
        );
      }, debounceMs);
    };

    /**
     * Where a chosen file opens: the file view of the project's newest ferret, or, with none (or when the lists cannot be
     * read), the project page with its finder seeded. Read when chosen, so the bar holds no ferret list of its own.
     */
    const destinationOf = async (projectId: string, path: string): Promise<string> => {
      const seeded = `${projectPath(context.daemon, projectId)}?find=${encodeURIComponent(path)}`;
      try {
        const project = (await fetchProjects(context.client)).find(row => row.id === projectId);
        if (project === undefined) return seeded;
        const ferret = projectFerrets(project.path, await readFerrets(context.client))[0];
        return ferret === undefined ? seeded : ferretFilePath(context.daemon, ferret.id, path);
      } catch {
        return seeded;
      }
    };

    const fileEntry = (projectId: string, path: string, rank: number): CommandBarEntry => {
      const { folder, name } = splitPath(path);
      return {
        id: fileEntryId(projectId, path),
        group: FILES_GROUP,
        label: name,
        description: folder === '' ? 'Top of the project' : folder,
        keywords: [path],
        order: rank,
        run: () => void destinationOf(projectId, path).then(context.navigate),
      };
    };

    /** The one line a failed read is listed as; choosing it opens the project page, whose finder says the same. */
    const failureEntry = (
      projectId: string,
      query: string,
      failure: NonNullable<Held['failure']>,
    ): CommandBarEntry => ({
      id: `file-failed-${idSafe(projectId)}`,
      group: FILES_GROUP,
      // The label says WHAT happened (a row's description is cut to one line on a phone, and the daemon's sentence is long);
      // the description is the daemon's own sentence. Not faded: this is the line the reader has to act on.
      label: failure.refused
        ? 'Search refused by the daemon'
        : failure.unavailable
          ? 'File search is not ready'
          : 'Could not search this project’s files',
      description: failure.reason,
      // The bar lists what the typed text matches: this line is the answer to every text it was asked for.
      keywords: [query],
      order: -1,
      run: () => context.navigate(`${projectPath(context.daemon, projectId)}?find=${encodeURIComponent(query)}`),
    });

    return {
      list: raw => {
        const projectId = currentProjectId(pathname(), context.daemon);
        if (projectId === undefined) return [];
        const query = searchText(raw);
        if (query === '') {
          // A cleared box (the bar opened again) forgets every answer, so nothing from a past opening is kept.
          clearTimeout(timer);
          abort?.abort();
          held = undefined;
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
        }
        const stale = held?.failure !== undefined && now() - held.failure.at >= retryMs;
        if (held?.projectId !== projectId || held.query !== query || stale) ask({ projectId, query });
        const read = held;
        if (read?.failure !== undefined) return [failureEntry(projectId, query, read.failure)];
        const paths = read?.paths;
        if (paths === undefined) return { entries: [], pending: 'Searching this project’s files…' };
        return paths.map((path, rank) => fileEntry(projectId, path, rank));
      },
    };
  };
