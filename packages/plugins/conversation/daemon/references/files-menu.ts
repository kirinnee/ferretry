import type { FerretFolderEntry, FerretsApi } from '@ferretry/core-ferrets/contract';
import { cap, ferretOf, isFerretCall } from '@ferretry/core-gate/contract';
import { ApiError, type FerretId } from '@ferretry/kernel/contract';
import {
  type ReferenceCatalogCaller,
  type ReferenceCatalogEntry,
  type ReferenceCatalogInput,
  type ReferenceCatalogProvider,
  referenceCatalogLimit,
} from '../../contract/index.ts';

/** The entry schema's own bounds (a name is the file system's: one past them is left out, never cut into another file's name). */
const MAX_TOKEN = 512;
const MAX_LABEL = 256;

/** Why a listed name is on the menu but not on offer: the browser's own badges, in words. */
const withheld = (entry: FerretFolderEntry): string | undefined => {
  if (entry.denied === true) return 'protected: never served';
  if (entry.ignored === true) return 'gitignored: listed, not served';
  if (entry.escapes === true) return 'a link out of this ferret: not served';
  return undefined;
};

/** A folder with nothing to list: the menu is empty, not broken (a half-typed path names none, a file is not a folder). */
const NOTHING_THERE: ReadonlySet<number> = new Set([400, 404]);

/**
 * Who is reading, as Ferrets' `mayTouch` rule wants it: a ferret's own token (or the admin token naming one) is that
 * ferret; any other agent (the Warden, an admin token naming none) reads NOTHING here, as the file browser route refuses it.
 */
const readerOf = (caller: ReferenceCatalogCaller): FerretId | undefined => {
  if (!isFerretCall(caller)) return undefined;
  const ferret = ferretOf(caller);
  if (ferret === undefined)
    throw new ApiError(
      403,
      'an agent reads only its own ferret’s files, and this request names no ferret of its own',
      'not_own_session',
    );
  return ferret;
};

/**
 * THE `@` MENU OF A FERRET'S COMPOSER (reference.catalog, lead decision Q6): ONE folder of the ferret's work tree, as the
 * file browser lists it. The query `q` is the folder (`''` is the root; a trailing `/` is ignored); a folder's token ends
 * in `/`; every token is ferret-root-relative (`src/app.ts`), the form the grammar's `@path` takes.
 *
 * THE FOLDER IS CONFINED TO THE FERRET'S ROOT three times over: the route refuses `..`, an absolute path and a NUL
 * before any provider runs; Ferrets resolves the path UNDER the ferret's root and refuses one that climbs out or whose
 * link leaves it; and the listing is read under the agent fence whoever asks (nothing inside the state home, no hard link).
 * A name the browser lists but never serves (denylisted, gitignored, a link out) is offered `closed` with its reason and
 * nothing else; a folder that is none of those but is not there (a half-typed path) answers no entries.
 *
 * DEMAND: `filesystem` use — what `GET /v1/ferrets/:ferretId/fs` declares, so a caller that could not browse the files
 * through that route is refused before `entries` runs. A ferret may list only itself and its helpers (`mayTouch`), asked
 * of Ferrets before the folder is touched. Only names and types leave: never a size, a time, a link target or a byte
 * of a file.
 */
export class FilesReferenceMenu implements ReferenceCatalogProvider {
  readonly demand = cap('filesystem', 'use');

  constructor(private readonly ferrets: Pick<FerretsApi, 'listFolder'>) {}

  async entries(input: ReferenceCatalogInput): Promise<readonly ReferenceCatalogEntry[]> {
    const reader = readerOf(input.caller);
    const folder = (input.query ?? '').replace(/\/+$/u, '');
    const listing = await this.ferrets
      .listFolder?.(input.ferret as FerretId, folder, reader)
      .catch((error: unknown) => {
        if (error instanceof ApiError && NOTHING_THERE.has(error.status)) return undefined;
        throw error;
      });
    if (listing === undefined) return [];
    const prefix = listing.path === '' ? '' : `${listing.path}/`;
    return listing.entries
      .filter(entry => prefix.length + entry.name.length + 1 <= MAX_TOKEN)
      .slice(0, referenceCatalogLimit('@'))
      .map(entry => {
        const why = withheld(entry);
        return {
          token: `${prefix}${entry.name}${entry.type === 'dir' ? '/' : ''}`,
          label: entry.name.slice(0, MAX_LABEL),
          ...(why === undefined ? {} : { detail: why, closed: true }),
        };
      });
  }
}
