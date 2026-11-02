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
    /** The person a `member_exists` refusal found holding the name. */
    readonly memberId?: string,
  ) {
    super(message);
    this.name = 'CatalogMemberRefusal';
  }
}

/** Narrows a protocol refusal for callers that only ever raise the wire's own. */
export const isShareRefusal = (code: CatalogMemberRefusalCode): code is CatalogShareRefusal =>
  (CATALOG_SHARE_REFUSALS as readonly string[]).includes(code);

/**
 * How each refusal answers over HTTP. A damaged store is this machine's fault (500) and no address to put in a
 * link is a 503; the owner's and the member's mistakes are 404 (no such id) or 409 (the state will not take it).
 */
export const CATALOG_MEMBER_STATUS: Readonly<Record<CatalogMemberRefusalCode, number>> = {
  share_refused: 409,
  share_other_member: 409,
  share_new_member: 409,
  member_exists: 409,
  members_full: 409,
  member_unknown: 404,
  member_key_unknown: 404,
  catalog_unknown: 404,
  share_unknown: 404,
  shares_full: 409,
  catalogs_full: 409,
  share_link_unavailable: 503,
  store_damaged: 500,
};
