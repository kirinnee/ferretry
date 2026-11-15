import { z } from 'zod';
import type { ProjectsClient } from './client.ts';

/**
 * THE NAMES OF A MACHINE'S PROJECTS, for labelling the cards the work search finds. A hit carries only its project's id
 * (a UUID, or `unfiled`), which no reader can use. The names are Board's list of board projects, read by route key
 * (`GET /v1/board/projects`) because that list also holds the Unfiled board; with Board off the read is refused and the
 * map is empty, so a hit shows its id rather than a guess.
 */
export const BOARD_PROJECTS_ROUTE = 'GET /v1/board/projects';

const BoardProjectNamesSchema = z.looseObject({
  projects: z.array(z.looseObject({ id: z.string().min(1), name: z.string().min(1) })),
});

export const workProjectNames = (
  projects: readonly { readonly id: string; readonly name: string }[],
): ReadonlyMap<string, string> => new Map(projects.map(project => [project.id, project.name] as const));

export const readWorkProjectNames = async (client: ProjectsClient): Promise<ReadonlyMap<string, string>> =>
  workProjectNames(BoardProjectNamesSchema.parse(await client.call(BOARD_PROJECTS_ROUTE)).projects);

/**
 * `conversation.work-project-names` (Conversation's app hook): the project names, read ONCE and kept. The first ask for
 * the names starts the one read, so a machine whose work search is never opened is never asked; a listing after that
 * fetches nothing. A read that fails (Board off, refused) leaves the map empty and is not repeated: the search then
 * shows what it shows without a name, never a guess.
 */
export const workProjectNamesList = (
  client: ProjectsClient,
): {
  readonly subscribe: (listener: () => void) => () => void;
  readonly settled: () => boolean;
  readonly names: () => ReadonlyMap<string, string>;
} => {
  let known: ReadonlyMap<string, string> = new Map();
  let started = false;
  let settled = false;
  const listeners = new Set<() => void>();
  /** The read is over: nobody is kept, since it never speaks again. Returns whoever was waiting. */
  const settle = (): readonly (() => void)[] => {
    settled = true;
    const waiting = [...listeners];
    listeners.clear();
    return waiting;
  };
  return {
    // A listener added once the read is over would wait for nothing, so it is not kept.
    subscribe: listener => {
      if (settled) return () => undefined;
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    settled: () => settled,
    names: () => {
      if (!started) {
        started = true;
        readWorkProjectNames(client).then(
          read => {
            known = read;
            for (const listener of settle()) listener();
          },
          // A failed read is not repeated and says nothing: the waiting are let go without being told.
          () => void settle(),
        );
      }
      return known;
    },
  };
};
