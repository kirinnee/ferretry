import { FerretIdSchema, type FerretsApi } from '@ferretry/core-ferrets/contract';
import { ApiError, decodeParameter, jsonResponse, queryValue, type RouteHandler } from '@ferretry/kernel/contract';
import {
  REFERENCE_CATALOG_MAX_QUERY,
  type ReferenceCatalogAnswer,
  type ReferenceCatalogCaller,
  type ReferenceCatalogEntry,
  ReferenceCatalogEntrySchema,
  type ReferenceCatalogPrefix,
  ReferenceCatalogPrefixSchema,
  type ReferenceCatalogProvider,
  referenceCatalogLimit,
} from '../../contract/index.ts';
import { refusedDemand } from './grant-refusal.ts';

export interface ReferenceCatalogDeps {
  readonly providerOf: (prefix: ReferenceCatalogPrefix) => ReferenceCatalogProvider | 'unavailable' | undefined;
  /** The ferrets on THIS daemon: a ferret that is not one answers 404, as the skills route does. */
  readonly ferrets: Pick<FerretsApi, 'get'>;
}

/**
 * The `@` menu is asked one directory at a time and the answer is confined to the ferret's root, so a query that
 * climbs out of it, names an absolute path or carries a NUL is refused here, before any provider sees it.
 */
function unconfinedFileQuery(query: string): boolean {
  if (query.includes('\0')) return true;
  if (query.startsWith('/') || query.startsWith('\\') || /^[A-Za-z]:/u.test(query)) return true;
  return query.split(/[\\/]/u).includes('..');
}

/**
 * `GET /v1/ferrets/:ferretId/references?prefix=&q=` (lead decision Q6): the entries the owner of one reference prefix
 * offers a ferret's composer.
 *
 * ORDER, because it is the security of the route: the request is validated; the provider is found; the provider's
 * DEMAND (files, terminals, pages: what their own routes already ask the operator) is asked of the caller, and a
 * refusal answers exactly as the direct route would; then the ferret must be on this daemon (404); then the entries.
 * A prefix nobody provides — or whose provider is off — answers `provided: false` and no entries, never an error. A
 * provider's entries are parsed before they are served; a provider that throws or answers nonsense is a 502 naming
 * only the prefix (a refusal it raises, 401 or 403, passes through unchanged). The answer is masked by the
 * `guard: 'secrets'` wrapper the daemon half puts around every such route (card titles and file names are words a
 * secret can be in).
 */
export function referenceCatalogRoute(deps: ReferenceCatalogDeps): RouteHandler {
  return async call => {
    const ferret = FerretIdSchema.safeParse(decodeParameter(call.params.get('ferretId') ?? '') ?? '');
    if (!ferret.success) throw new ApiError(400, 'the ferret id in the path is not usable', 'invalid_ferret_id');
    const prefix = ReferenceCatalogPrefixSchema.safeParse(queryValue(call.request, 'prefix'));
    if (!prefix.success) throw new ApiError(400, 'prefix must be one reference prefix', 'invalid_reference_prefix');
    const query = queryValue(call.request, 'q');
    if (query !== undefined && query.length > REFERENCE_CATALOG_MAX_QUERY)
      throw new ApiError(
        400,
        `q must be at most ${REFERENCE_CATALOG_MAX_QUERY.toLocaleString('en-US')} characters`,
        'invalid_reference_query',
      );
    if (prefix.data === '@' && query !== undefined && unconfinedFileQuery(query))
      throw new ApiError(400, 'q must name a directory under the ferret, not outside it', 'invalid_reference_query');

    const provider = deps.providerOf(prefix.data);
    const usable = provider === undefined || provider === 'unavailable' ? undefined : provider;
    if (usable?.demand !== undefined) {
      const refusal = refusedDemand(call, usable.demand);
      if (refusal !== undefined) return refusal;
    }
    if ((await deps.ferrets.get(ferret.data)) === undefined)
      throw new ApiError(404, `no ferret ${ferret.data}`, 'not_found');

    if (usable === undefined)
      return jsonResponse({
        ferret: ferret.data,
        prefix: prefix.data,
        provided: false,
        entries: [],
      } satisfies ReferenceCatalogAnswer);

    const caller: ReferenceCatalogCaller = {
      ...(call.actor === undefined ? {} : { actor: call.actor }),
      ...(call.credential === undefined ? {} : { credential: call.credential }),
      ...(call.governance === undefined ? {} : { governance: call.governance }),
      ...(call.presentation === undefined ? {} : { presentation: call.presentation }),
    };
    const failed = () => new ApiError(502, `the ${prefix.data} catalog could not be read`, 'reference_catalog_failed');
    let entries: ReferenceCatalogEntry[];
    try {
      const raw: unknown = await usable.entries({
        ferret: ferret.data,
        ...(query === undefined || query === '' ? {} : { query }),
        caller,
      });
      if (!Array.isArray(raw)) throw failed();
      const parsed = ReferenceCatalogEntrySchema.array().safeParse(raw.slice(0, referenceCatalogLimit(prefix.data)));
      if (!parsed.success) throw failed();
      entries = parsed.data;
    } catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) throw error;
      throw failed();
    }
    return jsonResponse({
      ferret: ferret.data,
      prefix: prefix.data,
      provided: true,
      entries,
    } satisfies ReferenceCatalogAnswer);
  };
}
