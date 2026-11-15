import { ApiError, type FerretId } from '@ferretry/kernel/contract';
import type { FerretFolderListing, FerretsApi } from '../../../contract/index.ts';
import { AGENT_READ_FENCE, FsError, type FsErrorCode, type SessionFilesystem } from '../session/filesystem/index.ts';

/** Every refusal of the file browser, as the status its own route answers (the route's table, kept in one place). */
export const FS_ERROR_STATUS: Readonly<Record<FsErrorCode, number>> = {
  invalid_path: 400,
  not_found: 404,
  not_a_directory: 400,
  not_a_file: 400,
  escapes_root: 403,
  denied: 403,
  ignored: 403,
  unsupported: 501,
};

export interface FolderListingDeps {
  /** The folder a ferret was started in, or `undefined` for a ferret this daemon does not know. */
  readonly folderOf: (ferret: FerretId) => string | undefined;
  /** The file browser's service for one ferret (stateless: one is made per ask). */
  readonly filesystem: (ferret: FerretId) => Pick<SessionFilesystem, 'list'>;
  /** Whether `caller` may act on `target` (itself, or a helper of its own lineage). */
  readonly mayTouch: (caller: FerretId, target: FerretId) => boolean;
}

/**
 * `FerretsApi.listFolder`: one folder of a ferret's work tree through the SAME service and the SAME fence the file
 * browser route gives an AGENT, whoever asks (the composer's `@` menu is never wider than the browser).
 *
 * ORDER, because it is the security of the member: an unknown ferret answers `undefined`; a `caller` that may not touch
 * the ferret is refused `403 forbidden` BEFORE the folder is touched; then the folder is listed under the fence
 * (`path` is resolved under the root by the service: `..`, an absolute path and a link out are its refusals). Only
 * names, types and the three badges leave: never a size, a time or a link target.
 */
export function folderLister(deps: FolderListingDeps): NonNullable<FerretsApi['listFolder']> {
  return async (ferret, path, caller): Promise<FerretFolderListing | undefined> => {
    const folder = deps.folderOf(ferret);
    if (folder === undefined) return undefined;
    if (caller !== undefined && !deps.mayTouch(caller, ferret))
      throw new ApiError(
        403,
        `a ferret reads only its own files and its helpers’, and ${ferret} is neither`,
        'forbidden',
      );
    try {
      const listing = await deps.filesystem(ferret).list(folder, path, { fence: AGENT_READ_FENCE });
      return {
        path: listing.path,
        entries: listing.entries.map(entry => ({
          name: entry.name,
          type: entry.type,
          ...(entry.denied === true ? { denied: true } : {}),
          ...(entry.ignored === true ? { ignored: true } : {}),
          ...(entry.escapes === true ? { escapes: true } : {}),
        })),
        ...(listing.truncated === true ? { truncated: true } : {}),
      };
    } catch (error) {
      if (error instanceof FsError) throw new ApiError(FS_ERROR_STATUS[error.code], error.message, error.code);
      throw error;
    }
  };
}
