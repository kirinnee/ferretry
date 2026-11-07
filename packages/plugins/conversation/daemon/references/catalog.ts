import { ApiError, decodeParameter, jsonResponse, queryValue, type RouteHandler } from '@ferretry/kernel/contract';
import { FerretIdSchema } from '@ferretry/core-ferrets/contract';
import {
  REFERENCE_CATALOG_MAX_ENTRIES,
  type ReferenceCatalogAnswer,
  ReferenceCatalogEntrySchema,
  ReferenceCatalogPrefixSchema,
  type ReferenceCatalogPrefix,
  type ReferenceCatalogProvider,
} from '../../contract/index.ts';

/** The most characters of a menu query passed to a provider. */
const MAX_QUERY = 256;

/**
 * `GET /v1/ferrets/:ferretId/references?prefix=&q=` (lead decision Q6): the entries the owner of one reference prefix
 * offers a ferret's composer. A prefix nobody provides — or whose provider is off — answers `provided: false` and no
 * entries, never an error. A provider's entries are parsed before they are served; a provider that throws or answers
 * nonsense is a 502 naming the prefix, not a silent empty list. The answer is masked by the `guard: 'secrets'`
 * wrapper the daemon half puts around every such route (card titles and file names are words a secret can be in).
 */
export function referenceCatalogRoute(
  providerOf: (prefix: ReferenceCatalogPrefix) => ReferenceCatalogProvider | 'unavailable' | undefined,
): RouteHandler {
  return async call => {
    const ferret = FerretIdSchema.safeParse(decodeParameter(call.params.get('ferretId') ?? '') ?? '');
    if (!ferret.success) throw new ApiError(400, 'the ferret id in the path is not usable', 'invalid_ferret_id');
    const prefix = ReferenceCatalogPrefixSchema.safeParse(queryValue(call.request, 'prefix'));
    if (!prefix.success) throw new ApiError(400, 'prefix must be one reference prefix', 'invalid_reference_prefix');
    const query = queryValue(call.request, 'q')?.slice(0, MAX_QUERY);
    const provider = providerOf(prefix.data);
    if (provider === undefined || provider === 'unavailable')
      return jsonResponse({
        ferret: ferret.data,
        prefix: prefix.data,
        provided: false,
        entries: [],
      } satisfies ReferenceCatalogAnswer);
    let raw: readonly unknown[];
    try {
      raw = await provider.entries({ ferret: ferret.data, ...(query === undefined || query === '' ? {} : { query }) });
    } catch {
      throw new ApiError(502, `the ${prefix.data} catalog could not be read`, 'reference_catalog_failed');
    }
    const entries = ReferenceCatalogEntrySchema.array().safeParse(raw.slice(0, REFERENCE_CATALOG_MAX_ENTRIES));
    if (!entries.success)
      throw new ApiError(
        502,
        `the ${prefix.data} catalog answered entries it could not read`,
        'reference_catalog_failed',
      );
    return jsonResponse({
      ferret: ferret.data,
      prefix: prefix.data,
      provided: true,
      entries: entries.data,
    } satisfies ReferenceCatalogAnswer);
  };
}
