/**
 * Why the links side said no, as a code the HTTP mount answers with and a sentence a person reads. The codes are
 * the owner wire's (`CATALOG_LINK_REFUSALS`) plus two the item side raises that a link passes on unchanged.
 */
import { CATALOG_LINK_REFUSALS } from '../boundary.ts';

export const LINK_REFUSALS = [...CATALOG_LINK_REFUSALS, 'store_damaged', 'items_full'] as const;
export type LinkRefusalCode = (typeof LINK_REFUSALS)[number];

/**
 * How each refusal answers. A damaged file is this machine's fault (500), a link store that cannot be reached or an
 * identity that cannot sign is a 503, and the rest are the caller's to fix.
 */
export const LINK_STATUS: Readonly<Record<LinkRefusalCode, number>> = {
  links_store_damaged: 500,
  link_unknown: 404,
  item_unknown: 404,
  version_unknown: 404,
  source_unknown: 404,
  source_ambiguous: 409,
  source_refused: 422,
  item_source_changed: 409,
  changed_since_preview: 409,
  link_kind_unsupported: 422,
  links_full: 409,
  version_retired: 409,
  version_linked: 409,
  link_too_big: 413,
  link_not_public: 409,
  link_not_live: 409,
  current_changed: 409,
  nothing_to_publish: 409,
  link_store_unavailable: 503,
  signing_unavailable: 503,
  store_damaged: 500,
  items_full: 409,
};

export class CatalogLinkRefusal extends Error {
  constructor(
    readonly refusal: LinkRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = 'CatalogLinkRefusal';
  }
}

/** True for a code the links side can carry, so a refusal from the item side is passed on and nothing else is. */
export const isLinkRefusalCode = (code: string): code is LinkRefusalCode =>
  (LINK_REFUSALS as readonly string[]).includes(code);
