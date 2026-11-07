import type { FerretSummary, FerretsApi } from '@ferretry/core-ferrets/contract';
import type { FerretId } from '@ferretry/kernel/contract';
import type { UsesHandle } from '@ferretry/kernel/manifest';
import type { BrowserPageRef, BrowsersApi } from '@ferretry/plugin-browsers/contract';

/**
 * TWO READS THE LEAD APPROVED THAT ARE NOT ON THIS BASE YET (DECISIONS-1 item 12). Each is read through a one-line
 * local widening marked TODO(contract); until its porter adds the field, the read finds nothing and the caller does
 * exactly what it does today without it (a page by name is refused; a session orders by the site lines alone).
 */

/** TODO(contract): `BrowserPageRef.url` (Browsers porter; daemon-side, read under the page hold). */
type PageWithUrl = BrowserPageRef & { readonly url?: string };

/** TODO(contract): a ferret's work folder and board project on `FerretSummary` (Ferrets porter; I184). */
type FerretWithPlace = FerretSummary & { readonly folder?: string; readonly project?: string };

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

/** Where a ferret works: its folder and board, from Ferrets, or `undefined` when Ferrets does not say. */
export async function ferretPlace(
  ferrets: UsesHandle<FerretsApi>,
  ferret: string,
): Promise<{ readonly folder?: string; readonly project?: string } | undefined> {
  const summary = (await ferrets
    .current()
    ?.get(ferret as FerretId)
    .catch(() => undefined)) as FerretWithPlace | undefined;
  if (summary === undefined) return undefined;
  return {
    ...(summary.folder === undefined ? {} : { folder: summary.folder }),
    ...(summary.project === undefined ? {} : { project: summary.project }),
  };
}

/**
 * TODO(contract): no kernel port resolves a folder's real path or names the owner's home (`banned-globals` refuses
 * `fs` and `homedir` in a plugin). A folder line is matched only on a path resolved at read time (the symlink-swap
 * check, I184), so until a port offers one, nothing resolves and folder lines order no card: they fail CLOSED, while
 * project and site lines still apply.
 */
export const realpath = async (_path: string): Promise<string | undefined> => undefined;

/** Unused while `realpath` resolves nothing: a `~/…` line can never match. */
export const ownerHome = (): string => '/';
