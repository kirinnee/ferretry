import { describe, it } from 'bun:test';
import { builtInModelCatalogs, publishedModelCatalogFiles } from '@ferretry/fleet';
import should from 'should';
import {
  type Bytes,
  type ModelCatalogFetchPort,
  PublishedModelCatalogService,
  spkiFromPem,
  verifyPublishedCatalog,
} from '../../../src/lib/models/published.ts';

const encode = (text: string): Bytes => new TextEncoder().encode(text) as Bytes;
const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const b64url = (bytes: Uint8Array): string => b64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
const sha = async (bytes: Bytes) => b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));

/** A throwaway release key, a hosted app signed with it, and the PEM a build would compile in. */
async function hostedApp(version: number, options: { tamper?: 'catalog' | 'version' } = {}) {
  const keys = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as unknown as CryptoKeyPair;
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', keys.publicKey));
  const pem = `-----BEGIN PUBLIC KEY-----\n${b64(spki)}\n-----END PUBLIC KEY-----\n`;
  const files = publishedModelCatalogFiles(version, builtInModelCatalogs());
  const catalog = encode(files['catalog/models.json'] as string);
  const list = encode(JSON.stringify({ version: '1.0.0', files: { 'catalog/models.json': await sha(catalog) } }));
  const signature = `${b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', spki)))}.${b64url(
    new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, keys.privateKey, list)),
  )}`;
  const served: Record<string, Bytes> = {
    'catalog/version.json': encode(files['catalog/version.json'] as string),
    'catalog/models.json': options.tamper === 'catalog' ? encode('{"version":1,"catalogs":{}}') : catalog,
    'release-manifest.json': list,
    'release-manifest.sig': encode(signature),
  };
  if (options.tamper === 'version') served['catalog/version.json'] = encode(JSON.stringify({ version: version + 1 }));
  return { pem, served, list, signature, catalog };
}

const fetchOf = (served: Record<string, Bytes>, overrides: Record<string, number | 'down'> = {}) => {
  const asked: string[] = [];
  const port: ModelCatalogFetchPort = {
    get: async path => {
      asked.push(path);
      const override = overrides[path];
      if (override === 'down') return undefined;
      if (typeof override === 'number') return { status: override, bytes: encode('') };
      const bytes = served[path];
      return bytes === undefined ? { status: 404, bytes: encode('') } : { status: 200, bytes };
    },
  };
  return { port, asked };
};

const memoryCache = (initial?: unknown) => {
  let held = initial;
  return {
    read: async () => held,
    write: async (document: unknown) => {
      held = document;
    },
    held: () => held,
  };
};

describe('verifyPublishedCatalog', () => {
  it('should take a catalog the signed release list names, and refuse every way it can be wrong', async () => {
    // Arrange
    const app = await hostedApp(7);
    const other = await hostedApp(7);
    const check = (patch: Partial<Parameters<typeof verifyPublishedCatalog>[0]>) =>
      verifyPublishedCatalog({
        publicKeyPem: app.pem,
        list: app.list,
        signature: app.signature,
        catalog: app.catalog,
        ...patch,
      });

    // Act / Assert
    should(await check({})).match({ ok: true });
    should(await check({ publicKeyPem: 'nope' })).match({ ok: false, reason: /carries no release key/ });
    should(await check({ signature: 'unsigned' })).match({ ok: false, reason: /not signed/ });
    should(await check({ signature: 'a.b.c' })).match({ ok: false, reason: /not signed/ });
    should(await check({ publicKeyPem: other.pem })).match({ ok: false, reason: /does not trust/ });
    should(await check({ list: encode('{"files":{}}') })).match({ ok: false, reason: /does not verify/ });
    should(await check({ catalog: encode('{}') })).match({
      ok: false,
      reason: /not the one the signed release list names/,
    });
  });

  it('should refuse a list that does not name the catalog, is not JSON, or vouches for a catalog that is not', async () => {
    // Arrange — sign three odd lists with one key
    const keys = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
      'sign',
      'verify',
    ])) as unknown as CryptoKeyPair;
    const spki = new Uint8Array(await crypto.subtle.exportKey('spki', keys.publicKey));
    const pem = `-----BEGIN PUBLIC KEY-----\n${b64(spki)}\n-----END PUBLIC KEY-----`;
    const fingerprint = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', spki)));
    const signed = async (list: Bytes, catalog: Bytes) =>
      await verifyPublishedCatalog({
        publicKeyPem: pem,
        list,
        catalog,
        signature: `${fingerprint}.${b64url(new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, keys.privateKey, list)))}`,
      });
    const notJson = encode('not json');

    // Act / Assert
    should(await signed(encode('{"files":{}}'), encode('{}'))).match({ reason: /does not name the catalog/ });
    should(await signed(encode('{nope'), encode('{}'))).match({ reason: /not a document/ });
    should(
      await signed(encode(JSON.stringify({ files: { 'catalog/models.json': await sha(notJson) } })), notJson),
    ).match({ reason: /the catalog is not a document/ });
    should(spkiFromPem('-----BEGIN PUBLIC KEY-----\n!!!\n-----END PUBLIC KEY-----')).be.undefined();
  });
});

describe('verifyPublishedCatalog with a key the platform cannot use', () => {
  it('should say the list signature does not verify, rather than fail, when the compiled-in key is not an Ed25519 key', async () => {
    // Arrange — a well-formed PEM of bytes that are not an SPKI key, with a signature naming that very key.
    const notAKey = encode('these bytes are not a public key');
    const pem = `-----BEGIN PUBLIC KEY-----\n${b64(notAKey)}\n-----END PUBLIC KEY-----`;
    const list = encode('{"files":{}}');

    // Act
    const answer = await verifyPublishedCatalog({
      publicKeyPem: pem,
      list,
      catalog: encode('{}'),
      signature: `${await sha(notAKey)}.${b64url(new Uint8Array(64))}`,
    });

    // Assert
    should(answer).match({ ok: false, reason: /does not verify/ });
  });
});

describe('PublishedModelCatalogService', () => {
  const NOW = Date.parse('2026-10-19T00:00:00.000Z');

  it('should take a newer published catalog, keep it, and say so once', async () => {
    // Arrange
    const app = await hostedApp(7);
    const { port } = fetchOf(app.served);
    const cache = memoryCache();
    const updated: number[] = [];
    const service = new PublishedModelCatalogService({
      fetch: port,
      cache,
      publicKeyPem: app.pem,
      nowMs: () => NOW,
      onUpdated: async version => {
        updated.push(version);
      },
    });

    // Act
    const result = await service.refresh(false);

    // Assert
    should(result).deepEqual({ outcome: 'updated', version: 7 });
    should(updated).deepEqual([7]);
    should((await service.catalogs())?.zai?.origin).equal('published');
    should(await service.status()).match({
      version: 7,
      fetchedAt: '2026-10-19T00:00:00.000Z',
      last: { outcome: 'updated' },
    });
    should(service.enabled).be.true();
  });

  it('should download nothing when the published version is the one held, and nothing at all before it is due', async () => {
    // Arrange — a machine that took version 7 an hour ago
    const app = await hostedApp(7);
    const { port, asked } = fetchOf(app.served);
    const document = JSON.parse(new TextDecoder().decode(app.catalog));
    const cache = memoryCache({ version: 7, document, checkedAt: new Date(NOW - 3_600_000).toISOString() });
    const service = new PublishedModelCatalogService({ fetch: port, cache, publicKeyPem: app.pem, nowMs: () => NOW });

    // Act
    const early = await service.refresh(false);
    const forced = await service.refresh(true);

    // Assert
    should(early).deepEqual({ outcome: 'not-due', version: 7 });
    should(forced).deepEqual({ outcome: 'unchanged', version: 7 });
    should(asked).deepEqual(['catalog/version.json']);
  });

  it('should keep what it holds when the hosted app is down, answers an error, or serves something wrong', async () => {
    // Arrange
    const app = await hostedApp(7);
    const run = async (fetch: ModelCatalogFetchPort, pem = app.pem) =>
      await new PublishedModelCatalogService({
        fetch,
        cache: memoryCache(),
        publicKeyPem: pem,
        nowMs: () => NOW,
      }).refresh(true);

    // Act / Assert
    should(await run(fetchOf(app.served, { 'catalog/version.json': 'down' }).port)).match({ outcome: 'unreachable' });
    should(await run(fetchOf(app.served, { 'release-manifest.sig': 503 }).port)).match({
      outcome: 'unreachable',
      reason: /answered 503 for release-manifest.sig/,
    });
    should(await run(fetchOf({ ...app.served, 'catalog/version.json': encode('nope') }).port)).match({
      outcome: 'refused',
    });
    should(await run(fetchOf((await hostedApp(7, { tamper: 'catalog' })).served).port, app.pem)).match({
      outcome: 'refused',
    });
    const shifted = await hostedApp(7, { tamper: 'version' });
    should(await run(fetchOf(shifted.served).port, shifted.pem)).match({
      outcome: 'refused',
      reason: /changed while it was read/,
    });
  });

  it('should refuse a signed catalog that is not a catalog document', async () => {
    // Arrange — sign a list for a document of the wrong shape
    const keys = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
      'sign',
      'verify',
    ])) as unknown as CryptoKeyPair;
    const spki = new Uint8Array(await crypto.subtle.exportKey('spki', keys.publicKey));
    const pem = `-----BEGIN PUBLIC KEY-----\n${b64(spki)}\n-----END PUBLIC KEY-----`;
    const catalog = encode('{"version":"seven"}');
    const list = encode(JSON.stringify({ files: { 'catalog/models.json': await sha(catalog) } }));
    const signature = `${b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', spki)))}.${b64url(
      new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, keys.privateKey, list)),
    )}`;
    const { port } = fetchOf({
      'catalog/version.json': encode('{"version":7}'),
      'catalog/models.json': catalog,
      'release-manifest.json': list,
      'release-manifest.sig': encode(signature),
    });

    // Act
    const result = await new PublishedModelCatalogService({
      fetch: port,
      cache: memoryCache(),
      publicKeyPem: pem,
      nowMs: () => NOW,
    }).refresh(true);

    // Assert
    should(result).match({ outcome: 'refused', reason: /not a catalog document/ });
  });

  it('should follow nothing when disabled, read a damaged cache as nothing held, and share one check', async () => {
    // Arrange
    const disabled = new PublishedModelCatalogService({
      cache: memoryCache('garbage'),
      publicKeyPem: '',
      nowMs: () => NOW,
    });
    const app = await hostedApp(3);
    const { port, asked } = fetchOf(app.served);
    const failingCache = {
      read: async () => {
        throw new Error('unreadable');
      },
      write: async () => {
        throw new Error('read-only');
      },
    };
    const service = new PublishedModelCatalogService({
      fetch: port,
      cache: failingCache,
      publicKeyPem: app.pem,
      nowMs: () => NOW,
      onUpdated: async () => {
        throw new Error('ignored');
      },
    });

    // Act
    const [first, second] = await Promise.all([service.refresh(true), service.refresh(true)]);
    service.refreshIfDue();

    // Assert
    should(await disabled.refresh(true)).deepEqual({ outcome: 'disabled' });
    should(await disabled.catalogs()).be.undefined();
    should(await disabled.status()).deepEqual({});
    should(disabled.enabled).be.false();
    should(first).deepEqual(second);
    should(asked.filter(path => path === 'catalog/version.json')).have.length(1);
    should(
      await new PublishedModelCatalogService({
        cache: memoryCache({ last: { outcome: 'refused' }, version: 'x' }),
        publicKeyPem: '',
        nowMs: () => NOW,
      }).status(),
    ).deepEqual({ last: { outcome: 'refused' } });
  });
});
