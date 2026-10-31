/**
 * Why the publisher side said no, as a code the HTTP mount answers with and a sentence a person reads.
 * Every refusal is the PERSON'S to fix except `store_damaged` and `export_failed`, which are this
 * machine's: a damaged file is never quietly replaced by an empty one.
 */
export const CATALOG_REFUSALS = [
  'catalog_unknown',
  'item_unknown',
  'item_withdrawn',
  'name_taken',
  'catalog_full',
  'public_unavailable',
  'source_unknown',
  'source_ambiguous',
  'source_refused',
  'changed_since_preview',
  'nothing_to_publish',
  'signing_unavailable',
  'store_damaged',
  'export_failed',
] as const;
export type CatalogRefusalCode = (typeof CATALOG_REFUSALS)[number];

export class CatalogRefusal extends Error {
  constructor(
    readonly refusal: CatalogRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = 'CatalogRefusal';
  }
}
