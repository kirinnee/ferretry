import { CATALOG_SHARE_REFUSALS, type CatalogShareRefusal } from '@ferretry/protocol';

/**
 * Why the member side said no, as a code the HTTP mount answers with and a sentence a person reads.
 *
 * The protocol's refusals are the ones a member or an owner is told; the rest are this machine's own:
 * a store that will not parse is never quietly replaced, and no address a link could carry means no code
 * is made at all.
 */
export const CATALOG_MEMBER_REFUSALS = [
  ...CATALOG_SHARE_REFUSALS,
  'shares_full',
  'catalogs_full',
  'share_link_unavailable',
  'store_damaged',
] as const;
export type CatalogMemberRefusalCode = (typeof CATALOG_MEMBER_REFUSALS)[number];

export class CatalogMemberRefusal extends Error {
  constructor(
    readonly refusal: CatalogMemberRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = 'CatalogMemberRefusal';
  }
}

/** Narrows a protocol refusal for callers that only ever raise the wire's own. */
export const isShareRefusal = (code: CatalogMemberRefusalCode): code is CatalogShareRefusal =>
  (CATALOG_SHARE_REFUSALS as readonly string[]).includes(code);
