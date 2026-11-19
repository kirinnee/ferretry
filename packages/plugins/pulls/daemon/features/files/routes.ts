import {
  ApiError,
  type CallContext,
  decodeParameter,
  jsonResponse,
  type RouteHandler,
} from '@ferretry/kernel/contract';
import { MAX_PULL_FILES, PULLS_CODES, PullFilesAnswerSchema } from '../../../contract/index.ts';
import { parseRepoSegment } from '../../../contract/repo-segment.ts';
import type { PullsServices } from '../../routes.ts';
import { shapeFiles } from './shape.ts';
import { resolveTarget } from './target.ts';

/** A path parameter decoded, or `''` when it is absent or not a plain segment (a separator, NUL, `.`, `..`). */
const param = (call: CallContext, name: string): string => decodeParameter(call.params.get(name) ?? '') ?? '';

const PER_PAGE = 100;
const MAX_PAGES = MAX_PULL_FILES / PER_PAGE;

/**
 * `GET /v1/pulls/:project/:repo/:number/files`: the files of a PR, read 100 at a time (GitHub lists at most 3000). A
 * conditional read: an unchanged PR answers from the cache (`304`) and costs no rate limit. The patch text is private
 * code, so the route is `filesystem.use` and the answer is never stored by a shared cache (`noStore`).
 */
export const filesRoute =
  (services: PullsServices): RouteHandler =>
  async call => {
    const named = parseRepoSegment(param(call, 'repo'));
    const repo = named === undefined ? undefined : ({ provider: 'github', ...named } as const);
    const number = Number(param(call, 'number'));
    if (repo === undefined || !Number.isSafeInteger(number) || number < 1)
      throw new ApiError(400, 'that is not a repository and pull request number', PULLS_CODES.refused);
    const target = await resolveTarget(services, param(call, 'project'), repo);
    if (!target.ok) throw new ApiError(target.status, target.message, target.code);

    const read = await services.github.getAll(
      {
        project: target.project,
        account: target.account,
        path: `/repos/${repo.owner}/${repo.name}/pulls/${number}/files?per_page=${PER_PAGE}`,
      },
      MAX_PAGES,
    );
    if (!read.ok) {
      // A pause is not an error the person caused: 429 with the instant it ends (the screen words it).
      if (read.error.code === PULLS_CODES.paused)
        throw new ApiError(429, read.error.message, read.error.code, undefined, {
          pausedUntilMs: read.error.pausedUntilMs,
        });
      throw new ApiError(read.error.code === PULLS_CODES.notFound ? 404 : 502, read.error.message, read.error.code);
    }
    const shaped = shapeFiles(read.value.items);
    return jsonResponse(
      PullFilesAnswerSchema.parse({
        files: shaped.files.slice(0, MAX_PULL_FILES),
        truncated: read.value.truncated || read.value.items.length >= MAX_PULL_FILES,
        unreadable: shaped.unreadable,
        fromCache: read.value.fromCache,
      }),
    );
  };
