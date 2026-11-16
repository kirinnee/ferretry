/**
 * S158 ON THE COMPOSED DAEMON HALF: a public link's key is sealed under the Vault's document with the per-link
 * `catalog-link:` AAD at 0600, and a key that cannot be opened is a damaged store (500 links_store_damaged), never a
 * link that is "not live". Also the app origin a link points at: the hosted app, whether or not Connections is on.
 */
import { describe, expect, it } from 'bun:test';
import type { SealedDocumentDef, SealedDocumentHandle, SealedDocumentsApi } from '@ferretry/core-vault/contract';
import { HOSTED_APP_ORIGIN } from '@ferretry/plugin-connections/contract';
import { CatalogLinkKeys } from '../../../contract/storage.ts';
import { catalogsFixture } from '../../support/daemon-host.ts';
import { storedLink } from '../catalog-links/support.ts';

const KEY = 'K'.repeat(43);

/** A sealed port that holds one key for every link, can start failing, and remembers the documents it was asked for. */
function sealedPort() {
  const state = { broken: false, opened: [] as SealedDocumentDef[] };
  const port: SealedDocumentsApi = {
    open(_own, document) {
      state.opened.push(document);
      return {
        names: async () => [],
        put: async () => undefined,
        get: async () => {
          if (state.broken) throw new Error('the sealed file did not authenticate');
          return KEY;
        },
        getBytes: async () => undefined,
        delete: async () => true,
      } satisfies SealedDocumentHandle;
    },
  };
  return { port, state };
}

describe('the public link key store', () => {
  it('S158 should seal link keys under the catalog-link: prefix, owner-only, as a store secret', () => {
    // Assert
    expect(CatalogLinkKeys.additionalData).toBe('catalog-link:');
    expect(CatalogLinkKeys.state.mode).toBe(0o600);
    expect(CatalogLinkKeys.state.store).toBe('secret');
    expect(CatalogLinkKeys.stamped).toBe(false);
  });

  it('S158 should open the sealed document Catalogs declares, and no other', async () => {
    // Arrange
    const sealed = sealedPort();

    // Act
    await catalogsFixture({ sealed: sealed.port });

    // Assert
    expect(sealed.state.opened).toEqual([CatalogLinkKeys]);
  });

  it('S158 should answer a Copy over a sealed store that cannot be opened 500 links_store_damaged, not link_not_live', async () => {
    // Arrange — one live public link on file, and a sealed store that stops authenticating
    const sealed = sealedPort();
    const fx = await catalogsFixture({ sealed: sealed.port });
    const link = storedLink({ state: 'live', kind: 'public', publisher: fx.daemonId });
    fx.host.state('catalogs').files.set('links.json', JSON.stringify({ format: 1, schemaVersion: 1, links: [link] }));
    expect((await fx.host.request('POST', `/v1/catalog-links/${link.linkId}/copy`)).status).toBe(200);
    sealed.state.broken = true;

    // Act
    const copied = await fx.host.request('POST', `/v1/catalog-links/${link.linkId}/copy`);

    // Assert
    expect(copied.status).toBe(500);
    expect(copied.json<{ code: string }>().code).toBe('links_store_damaged');
    expect(copied.body).not.toContain(KEY);
  });

  it('should point a Copy at the hosted app when Connections is off', async () => {
    // Arrange
    const sealed = sealedPort();
    const fx = await catalogsFixture({
      advertisement: undefined,
      sealed: sealed.port,
      config: { 'catalogs.yaml': { linkStore: { url: 'https://links.example.test' } } },
    });
    const link = storedLink({ state: 'live', kind: 'public', publisher: fx.daemonId });
    fx.host.state('catalogs').files.set('links.json', JSON.stringify({ format: 1, schemaVersion: 1, links: [link] }));

    // Act
    const copied = await fx.host.request('POST', `/v1/catalog-links/${link.linkId}/copy`);

    // Assert
    expect(copied.status).toBe(200);
    const url = new URL(copied.json<{ url: string }>().url);
    expect(url.origin).toBe(new URL(HOSTED_APP_ORIGIN).origin);
    expect(url.hash).toContain(`k=${KEY}`);
  });
});
