import type { FerretsApi } from '@ferretry/core-ferrets/contract';
import { agentControlRefusal, ApiError, type FerretId } from '@ferretry/kernel/contract';
import type { UsesHandle } from '@ferretry/kernel/manifest';
import type { BoardApi } from '@ferretry/plugin-board/contract';
import type { BrowsersApi } from '@ferretry/plugin-browsers/contract';
import type { ProjectsApi } from '@ferretry/plugin-projects/contract';
import type { ProjectInfo } from '../lib/sign-in-context.ts';

/**
 * WHAT ACCOUNTS READS ABOUT WHERE A FERRET WORKS (I184), each from the plugin that owns it and each total: a plugin that
 * is off, or a read that fails, says nothing, and the caller does exactly what it does today without it (a page by name
 * is refused; a session orders by the site lines alone, never a lost card).
 */

/**
 * The address of the page `name` that `ferret` holds (`scheme://host[:port]`), or `undefined` (Browsers off or offering
 * none, no such page, a page that is a person's or held, a page with no web address).
 *
 * THE ADDRESS IS BROWSERS' TO GIVE, and gated there on the ferret's "What agents may control › Browsers" switch (#42 SF2):
 * Browsers refuses with `agentControlRefusal('browser')` while it is off, and that refusal is PASSED THROUGH here, never
 * swallowed, so `account_hint {name}` says why. There is no check in Accounts, and no address is ever read from `pagesOf`
 * (which asks no switch). Only a refusal is let through: any other failure is "no address".
 */
export async function pageAddressOf(
  browsers: UsesHandle<BrowsersApi>,
  ferret: string,
  name: string,
): Promise<string | undefined> {
  const api = browsers.current();
  if (api?.pageAddressOf === undefined) return undefined;
  try {
    return await api.pageAddressOf(ferret as FerretId, name);
  } catch (error) {
    if (error instanceof ApiError && error.status === 403 && error.message === agentControlRefusal('browser'))
      throw error;
    return undefined;
  }
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
 * The board a ferret works on, from the Board (today's `projectOf(session)`): its project id (`unfiled` only when the
 * Board itself answers it). `undefined` when the Board is off, offers no `projectOf` or the read fails, so the caller
 * orders by the site lines alone (today's behaviour) and never borrows a folder default.
 */
export async function boardProjectOf(board: UsesHandle<BoardApi>, ferret: string): Promise<string | undefined> {
  return await board
    .current()
    ?.projectOf?.(ferret as FerretId)
    .catch(() => undefined);
}

/** The registered projects (their ids and names), or none when Projects is off or cannot be read. */
export async function registeredProjects(projects: UsesHandle<ProjectsApi>): Promise<readonly ProjectInfo[]> {
  const listed = await projects
    .current()
    ?.list()
    .catch(() => undefined);
  return (listed ?? []).map(each => ({ id: each.id, name: each.name }));
}
