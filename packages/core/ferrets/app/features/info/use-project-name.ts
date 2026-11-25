import { useAppHook, useOptionalRouter } from '@ferretry/app';
import { useSyncExternalStore } from 'react';
import { daemonOfRoute } from '../header/header-paths.ts';

/**
 * THE NAME OF A FERRET'S PROJECT, for Info's Project row: the board project's id is a UUID no reader can use. The names are
 * Projects' (the board projects); Conversation's work search already asks for them through its app hook below, which Projects
 * provides over its own client on this daemon. Info reads that same hook, given by name (the name and the shape are the whole
 * agreement), so it holds no second list and imports no other plugin.
 *
 * FAIL CLOSED: with no provider (Projects off on this daemon), a list not yet read or one that failed, there is no name, and
 * the row says the ferret is in a project without showing an id.
 */
const WORK_PROJECT_NAMES_HOOK = 'conversation.work-project-names';

interface NameList {
  readonly subscribe: (listener: () => void) => () => void;
  readonly names: () => ReadonlyMap<string, string>;
}

const isNameList = (value: unknown): value is NameList =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { subscribe?: unknown }).subscribe === 'function' &&
  typeof (value as { names?: unknown }).names === 'function';

const NO_NAMES: ReadonlyMap<string, string> = new Map();
const noSubscription = (): (() => void) => () => undefined;

/** The project's name, or `null` when it is not known (yet). The one read of the list starts only when an id is asked about. */
export function useProjectName(projectId: string | null): string | null {
  const router = useOptionalRouter();
  const daemon = router === null ? undefined : daemonOfRoute(router.route);
  const provided = useAppHook(daemon, WORK_PROJECT_NAMES_HOOK);
  const list = isNameList(provided) ? provided : undefined;
  const read = (): ReadonlyMap<string, string> => (projectId === null || list === undefined ? NO_NAMES : list.names());
  const names = useSyncExternalStore(list?.subscribe ?? noSubscription, read, read);
  return projectId === null ? null : (names.get(projectId) ?? null);
}
