/** Shared catalogs, their items, versions, installs and links (`catalogs.*`, `catalog-installs.*`). One fragment of `DAEMON_FEATURES`; `index.ts` spreads them all. */
export const CATALOG_FEATURES = {
  /**
   * Shared catalog items (docs/catalogs.md § One item in many catalogs, and the default): `GET /v1/catalog-items`, a default catalog
   * (`role` and `defaultCatalogId` in the lists, `PATCH /v1/catalogs/:id { role: 'default' }`) and adding an item
   * this machine already keeps to another catalog (`POST /v1/catalogs/:id/items { itemId, version }`). A daemon
   * without this name answers 404 or refuses the strict body: the app offers these only where the machine reports it.
   */
  catalogItems: 'catalogs.items.1',
  /**
   * One-tap Add into the default catalog, and its Undo (docs/catalogs.md § One-tap Add):
   * `POST /v1/catalog-items/quick-add` and `…/quick-add/undo`. A daemon without this name answers 404: the app offers
   * the one-tap button only where the machine reports it, and opens the review sheet otherwise.
   */
  catalogQuickAdd: 'catalogs.quick-add.1',
  /**
   * Item-level versions (docs/catalogs.md § What changed): `GET /v1/catalog-items/:itemId`, `…/versions/:version`,
   * `…/changes`, and the preview and publish of an update at the item. A daemon without this name answers 404, so the
   * app shows a version view and an item publish only where the machine reports it.
   */
  catalogVersions: 'catalogs.versions.1',
  /**
   * Making a version current, retiring one, and the signed version list (docs/catalogs.md § Making a version current):
   * `PUT /v1/catalog-items/:itemId/current`, `PATCH …/versions/:version` and the member route
   * `GET /v1/shared/catalogs/:catalogId/items/:itemId/versions`. A daemon without this name answers 404.
   */
  catalogVersions2: 'catalogs.versions.2',
  /**
   * The installing machine's half of versions (docs/catalogs.md § Updating an install): an install preview that takes
   * the publisher's signed `signedVersions` and `replaceEdited`, answers `changes` and `edited`, refuses edits with
   * `catalog_install_edited`, and `PATCH /v1/catalog-installs/<scope>/:installId` (stay or skip). A daemon without this
   * name refuses the strict fields and answers 404: the app moves to another version only where the machine reports it.
   */
  catalogInstallUpdates: 'catalog-installs.updates.1',
  /**
   * A later invite proves the person's passkey, and the owner may mark one invite "They need a new passkey"
   * (docs/catalogs.md § Joining as someone who is already here): the `join-options` record, the optional `passkey` on a
   * join, `newPasskey` on a mint and `PUT/DELETE /v1/catalog-shares/:shareId/new-passkey`. A daemon without this name
   * lets a later invite join without a proof, so the app offers the proof step only where the machine reports it.
   */
  catalogJoinProof: 'catalogs.join-proof.1',
  /**
   * Owner links (docs/catalogs.md § Links): `/v1/catalog-links` makes, lists, shows, copies, moves, edits and turns off a
   * link to one skill or MCP setup, kept at a link store; `usedBy.linkIds` names the links serving a version and a
   * version a link serves cannot be retired (`version_linked`).
   */
  catalogLinks: 'catalogs.links.1',
} as const;
