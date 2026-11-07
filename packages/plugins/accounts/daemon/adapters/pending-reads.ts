import type { FerretsApi } from '@ferretry/core-ferrets/contract';
import type { FerretId } from '@ferretry/kernel/contract';
import type { UsesHandle } from '@ferretry/kernel/manifest';
import type { BoardApi } from '@ferretry/plugin-board/contract';
import type { BrowserPageRef, BrowsersApi } from '@ferretry/plugin-browsers/contract';
import type { ProjectsApi } from '@ferretry/plugin-projects/contract';
import type { ProjectInfo } from '../lib/sign-in-context.ts';
import { UNFILED_PROJECT_ID } from '../lib/sign-in-context.ts';

/**
 * WHAT ACCOUNTS READS ABOUT WHERE A FERRET WORKS (I184), each from the plugin that owns it and each total: a plugin that
 * is off, or a read that fails, says nothing, and the caller does exactly what it does today without it (a page by name
 * is refused; a session orders by the site lines alone, never a lost card).
 */

/** TODO(contract): `BrowserPageRef.url` (Browsers porter; daemon-side, read under the page hold). */
type PageWithUrl = BrowserPageRef & { readonly url?: string };

/** The address of the page `name` that `ferret` holds, or `undefined` (no such page, or no URL offered yet). */
export async function pageUrlOf(
  browsers: UsesHandle<BrowsersApi>,
  ferret: string,
  name: string,
): Promise<string | undefined> {
  const pages = await browsers
    .current()
    ?.pagesOf(ferret as FerretId)
    .catch(() => undefined);
  const page = pages?.find(each => each.name === name) as PageWithUrl | undefined;
  return page?.url;
}

/**
 * The folder a ferret was started in, as its REAL path (Ferrets resolves it through its fenced `work` root and answers
 * nothing for a folder swapped for a symlink elsewhere, a failed resolve or an unknown ferret), or `undefined`.
 */
export async function workFolderOf(ferrets: UsesHandle<FerretsApi>, ferret: string): Promise<string | undefined> {
  const place = await ferrets
    .current()
    ?.workFolder(ferret as FerretId)
    .catch(() => undefined);
  return place?.folder;
}

/**
 * The ferret an owner's own card goes on when the request named none (today's `mostRecentLiveSession`): the most
 * recently active ferret that has not ended. `undefined` when none runs, which the caller says out loud.
 */
export async function ownerFerretOf(ferrets: UsesHandle<FerretsApi>): Promise<string | undefined> {
  const listed = await ferrets
    .current()
    ?.list()
    .catch(() => undefined);
  const live = (listed ?? []).filter(each => each.state !== 'stopped');
  live.sort((a, b) => (a.stateAt === b.stateAt ? a.id.localeCompare(b.id) : b.stateAt.localeCompare(a.stateAt)));
  return live[0]?.id;
}

/**
 * The board a ferret works on, from the Board (today's `projectOf(session)`): its project id, or `unfiled` when Board
 * is off, does not say, or the ferret has none.
 */
export async function boardProjectOf(board: UsesHandle<BoardApi>, ferret: string): Promise<string> {
  const project = await board
    .current()
    ?.projectOf?.(ferret as FerretId)
    .catch(() => undefined);
  return project ?? UNFILED_PROJECT_ID;
}

/** The registered projects (their ids and names), or none when Projects is off or cannot be read. */
export async function registeredProjects(projects: UsesHandle<ProjectsApi>): Promise<readonly ProjectInfo[]> {
  const listed = await projects
    .current()
    ?.list()
    .catch(() => undefined);
  return (listed ?? []).map(each => ({ id: each.id, name: each.name }));
}

/**
 * TODO(contract): `KernelPorts.paths.home()` (daemon halves; kernel `264a2037a`) is not on this base, so the owner's
 * home is unknown here and a `~/…` folder line can never match (it fails CLOSED; project and site lines still apply).
 * `workFolderOf` already answers a verified real path, so there is nothing left to resolve.
 */
export const ownerHome = (): string => '/';
