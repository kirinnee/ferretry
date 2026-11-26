import { describe, it } from 'bun:test';
import { builtInModelCatalogs } from '../../../daemon/lib/catalog/catalog.ts';
import { publishedModelCatalogFiles } from '../../../daemon/lib/catalog/published.ts';
import type { Suggestions } from '../../../daemon/lib/catalog/suggestions.ts';
import { ModelCatalogService } from '../../../daemon/lib/models/service.ts';
import { modelCatalogSourcesView } from '../../../daemon/lib/models/sources.ts';
import should from 'should';
import {
  type Bytes,
  type ModelCatalogFetchPort,
  PublishedModelCatalogService,
  spkiFromPem,
  verifyPublishedCatalog,
} from '../../../daemon/lib/models/published.ts';

const encode = (text: string): Bytes => new TextEncoder().encode(text) as Bytes;
const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const b64url = (bytes: Uint8Array): string => b64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
const sha = async (bytes: Bytes) => b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));

/** A throwaway release key, a hosted app signed with it, and the PEM a build would compile in. */
async function hostedApp(
  version: number,
  options: { tamper?: 'catalog' | 'version'; suggestions?: Suggestions; keys?: CryptoKeyPair } = {},
) {
  const keys =
    options.keys ??
    ((await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as unknown as CryptoKeyPair);
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', keys.publicKey));
  const pem = `-----BEGIN PUBLIC KEY-----\n${b64(spki)}\n-----END PUBLIC KEY-----\n`;
  const files = publishedModelCatalogFiles(version, builtInModelCatalogs(), options.suggestions);
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
  return { pem, served, list, signature, catalog, keys };
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

  it('should refuse a signature whose base64url text is one character past a whole group, whatever DOM is loaded', async () => {
    // Arrange — a signature segment of length 1 and of length 5 (both length % 4 === 1) is never valid base64url
    const app = await hostedApp(7);
    const [fingerprint] = app.signature.split('.');
    const check = (signature: string) =>
      verifyPublishedCatalog({ publicKeyPem: app.pem, list: app.list, signature, catalog: app.catalog });

    // Act / Assert
    should(await check(`${fingerprint}.b`)).match({ ok: false, reason: /not signed/ });
    should(await check(`${fingerprint}.abcde`)).match({ ok: false, reason: /not signed/ });
    should(await check(`${fingerprint}.ab+c`)).match({ ok: false, reason: /not signed/ });
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
  it('updates a changed signed discovery snapshot even when its curated version is unchanged', async () => {
    const app = await hostedApp(12);
    const cache = memoryCache();
    let updates = 0;
    const service = new PublishedModelCatalogService({
      fetch: fetchOf(app.served).port,
      cache,
      publicKeyPem: app.pem,
      nowMs: () => NOW,
      onUpdated: async () => {
        updates += 1;
      },
    });
    should(await service.refresh(true)).match({ outcome: 'updated' });
    // The same release key signs a different snapshot under curated version 12.
    const changed = await hostedApp(12, {
      keys: app.keys,
      suggestions: {
        generated: '2026-10-19',
        sources: { modelsDev: 'https://models.dev/api.json' },
        providers: { deepseek: { name: 'DeepSeek', models: { fresh: { name: 'Fresh', tool_call: true } } } },
      },
    });
    const next = new PublishedModelCatalogService({
      fetch: fetchOf(changed.served).port,
      cache,
      publicKeyPem: changed.pem,
      nowMs: () => NOW,
      onUpdated: async () => {
        updates += 1;
      },
    });
    should(await next.refresh(true)).match({ outcome: 'updated', version: 12 });
    should((await next.discovery())?.providers.deepseek?.models.fresh?.name).equal('Fresh');
    should(updates).equal(2);
  });

  it('ignores an unproven cached discovery document and explains the refusal with fetch disabled', async () => {
    const app = await hostedApp(12, {
      suggestions: {
        generated: '2026-10-19',
        sources: { modelsDev: 'https://models.dev/api.json' },
        providers: { deepseek: { name: 'DeepSeek', models: { forged: { name: 'Forged', tool_call: true } } } },
      },
    });
    const service = new PublishedModelCatalogService({
      cache: memoryCache({ version: 12, document: JSON.parse(new TextDecoder().decode(app.catalog)) }),
      publicKeyPem: app.pem,
      nowMs: () => NOW,
    });
    should(await service.discovery()).be.undefined();
    should(await service.catalogs()).be.undefined();
    should(await service.status()).match({ last: { outcome: 'refused', reason: /cache.*signature|cache.*proof/ } });
  });

  it('reverifies persisted proof after restart and refuses tampering or a changed trust key', async () => {
    const app = await hostedApp(12, {
      suggestions: {
        generated: '2026-10-19',
        sources: { modelsDev: 'https://models.dev/api.json' },
        providers: { deepseek: { name: 'DeepSeek', models: { fresh: { name: 'Fresh', tool_call: true } } } },
      },
    });
    const cache = memoryCache();
    const deps = { cache, publicKeyPem: app.pem, nowMs: () => NOW };
    await new PublishedModelCatalogService({ ...deps, fetch: fetchOf(app.served).port }).refresh(true);
    should((await new PublishedModelCatalogService(deps).catalogs())?.deepseek).not.be.undefined();
    should((await new PublishedModelCatalogService(deps).discovery())?.providers.deepseek?.models.fresh?.name).equal(
      'Fresh',
    );
    const other = await hostedApp(12);
    should(await new PublishedModelCatalogService({ ...deps, publicKeyPem: other.pem }).catalogs()).be.undefined();
    const altered = structuredClone(cache.held()) as { document: { version: number } };
    altered.document.version = 99;
    should(await new PublishedModelCatalogService({ ...deps, cache: memoryCache(altered) }).catalogs()).be.undefined();
  });
  it('projects separate discovery only after the signed snapshot checks, without changing curated defaults', async () => {
    const app = await hostedApp(12, {
      suggestions: {
        generated: '2026-10-19',
        sources: { modelsDev: 'https://models.dev/api.json' },
        providers: {
          deepseek: {
            name: 'DeepSeek',
            env: ['DEEPSEEK_API_KEY'],
            models: {
              'deepseek-flash': {
                name: 'DeepSeek Flash',
                tool_call: true,
                reasoning: true,
                limit: { context: 131072 },
                cost: { input: 0.1 },
              },
            },
          },
        },
      },
    });
    const fetch = fetchOf(app.served);
    const published = new PublishedModelCatalogService({
      fetch: fetch.port,
      cache: memoryCache(),
      publicKeyPem: app.pem,
      nowMs: () => NOW,
    });
    should(await published.discovery()).be.undefined();
    should(await published.refresh(true)).match({ outcome: 'updated' });
    const expected = {
      providers: {
        deepseek: {
          name: 'DeepSeek',
          env: ['DEEPSEEK_API_KEY'],
          models: {
            'deepseek-flash': { name: 'DeepSeek Flash', tool_call: true, reasoning: true, limit: { context: 131072 } },
          },
        },
      },
    };
    should(await published.discovery()).deepEqual(expected);
    const service = new ModelCatalogService({
      files: async () => ({}),
      presets: async () => [],
      published: () => published.catalogs(),
      discovery: () => published.discovery(),
    });
    const view = modelCatalogSourcesView(await service.sources());
    should(view.discovery).deepEqual(expected);
    should(view.catalogs.deepseek?.opencode).deepEqual(builtInModelCatalogs().deepseek?.opencode);
    const tampered = await hostedApp(12, { tamper: 'catalog' });
    const refused = new PublishedModelCatalogService({
      fetch: fetchOf(tampered.served).port,
      cache: memoryCache(),
      publicKeyPem: tampered.pem,
      nowMs: () => NOW,
    });
    should(await refused.refresh(true)).match({ outcome: 'refused' });
    should(await refused.discovery()).be.undefined();
  });

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
    // Arrange — a machine that took and verified version 7 an hour ago
    const app = await hostedApp(7);
    const { port, asked } = fetchOf(app.served);
    const cache = memoryCache();
    await new PublishedModelCatalogService({
      fetch: port,
      cache,
      publicKeyPem: app.pem,
      nowMs: () => NOW - 3_600_000,
    }).refresh(true);
    asked.splice(0);
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
    const wrongDigest = {
      ...app.served,
      'catalog/version.json': encode(JSON.stringify({ version: 7, digest: 'A'.repeat(43) })),
    };
    should(await run(fetchOf(wrongDigest).port)).match({
      outcome: 'refused',
      reason: /digest changed while it was read/,
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
