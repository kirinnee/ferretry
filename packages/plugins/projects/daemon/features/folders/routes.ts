import { ApiError, jsonResponse, queryValue, type RouteHandler } from '@ferretry/kernel/contract';
import { MakeFolderRequestSchema } from '../../../contract/index.ts';
import { parseBody } from '../../lib/body.ts';
import type { FolderExplorer } from './browse.ts';

/** `GET /v1/projects/folders?path=<abs or ~/x>&hidden=1`: one folder's names. Starts at `~`. */
export const listFoldersRoute =
  (explorer: FolderExplorer): RouteHandler =>
  async call => {
    for (const [name] of call.request.query) {
      if (name !== 'path' && name !== 'hidden')
        throw new ApiError(400, `unknown folders parameter ${name}`, 'unknown_parameter');
    }
    const hidden = queryValue(call.request, 'hidden');
    if (hidden !== undefined && hidden !== '0' && hidden !== '1')
      throw new ApiError(400, 'hidden is 0 or 1', 'invalid_hidden');
    return jsonResponse(await explorer.list(queryValue(call.request, 'path') ?? '~', hidden === '1'));
  };

/** `POST /v1/projects/folders` `{parent, name}`: makes one new folder, owner-only. */
export const makeFolderRoute =
  (explorer: FolderExplorer): RouteHandler =>
  async call =>
    jsonResponse(await explorer.make(await parseBody(call.request, MakeFolderRequestSchema)));
