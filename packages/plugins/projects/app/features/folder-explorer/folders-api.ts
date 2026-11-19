/**
 * THE EXPLORER'S TWO ROUTES. `GET /v1/projects/folders` lists one folder; `POST /v1/projects/folders` makes one. Both
 * answers are parsed by the contract's own schemas, so the explorer never draws a shape the daemon did not promise.
 */
import {
  type FolderListing,
  FolderListingSchema,
  type MakeFolderResult,
  MakeFolderResultSchema,
  NewFolderNameSchema,
} from '../../../contract/index.ts';
import type { ProjectsClient } from '../../lib/client.ts';

const LIST_FOLDERS_ROUTE = 'GET /v1/projects/folders';
const MAKE_FOLDER_ROUTE = 'POST /v1/projects/folders';

/** One folder's listing. `path` is absolute or `~`-relative; the daemon starts at `~` when it is omitted. */
export const listFolder = async (
  client: ProjectsClient,
  path: string | undefined,
  showHidden: boolean,
  signal?: AbortSignal,
): Promise<FolderListing> =>
  FolderListingSchema.parse(
    await client.call(LIST_FOLDERS_ROUTE, {
      query: { ...(path === undefined ? {} : { path }), ...(showHidden ? { hidden: '1' } : {}) },
      ...(signal === undefined ? {} : { signal }),
    }),
  );

/** Whether a typed name would pass the daemon's own rule, answered with the rule's sentence (`null` = fine or empty). */
export const newFolderProblem = (name: string): string | null => {
  if (name === '') return null;
  const parsed = NewFolderNameSchema.safeParse(name);
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? 'that is not a folder name');
};

/** Makes one folder directly under `parent` and answers where it is. */
export const makeFolder = async (client: ProjectsClient, parent: string, name: string): Promise<MakeFolderResult> =>
  MakeFolderResultSchema.parse(await client.call(MAKE_FOLDER_ROUTE, { body: { parent, name } }));
