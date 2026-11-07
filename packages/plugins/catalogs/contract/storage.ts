import { defineState } from '@ferretry/kernel/contract';
import { defineSealedDocument } from '@ferretry/core-vault/contract';

/** Today's public-link keys retain the vault cipher and per-link AAD. */
export const CatalogLinkKeys = defineSealedDocument({
  name: 'link-keys',
  path: 'link-keys.json',
  additionalData: 'catalog-link:',
  stamped: false,
});
export const CatalogInstallPrefs = defineState({
  name: 'install-prefs',
  path: 'install-prefs.json',
  store: 'json',
  format: 1,
});
