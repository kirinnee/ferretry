import { describe, it } from 'bun:test';
import { type AnalyticsPricingRate, FY_DEFAULT_DAEMON_URL, ManualAnalyticsPricingRateSchema } from '@ferretry/protocol';
import should from 'should';
import { ConfigGrantDocument } from '../../../src/adapters/grants/index.ts';
import { DaemonConfigDocumentError, FileDaemonConfig } from '../../../src/adapters/runtime/daemon-config.ts';
import { KeyedSerialExecutor } from '../../../src/adapters/system/keyed-serial-executor.ts';
import {
  analyticsPricingFingerprint,
  analyticsPricingSourcesFingerprint,
} from '../../../src/lib/analytics/pricing-catalog.ts';
import { AnalyticsPricingService } from '../../../src/lib/analytics/pricing-service.ts';
import {
  DEFAULT_CAPABILITY_GRANTS,
  type FileSystemPort,
  type FoundationPaths,
  supersededCarrierKeys,
} from '../../../src/lib/index.ts';

const paths = { daemonConfig: '/state/config/daemon.json' } as FoundationPaths;
const SYNCED_AT = '2026-08-06T12:00:00.000Z';

const manualRate = (pricingKey = 'manual:gpt-5:2026-08'): AnalyticsPricingRate => ({
  pricingKey,
  modelId: 'gpt-5',
  aliases: [],
  provider: 'openai',
  currency: 'USD',
  rates: {
    input: 1,
    output: 2,
    cachedInput: 1,
    cacheWrite: null,
    cacheWrite5m: null,
    cacheWrite1h: null,
    reasoning: 3,
    image: null,
    tool: null,
  },
  source: { kind: 'manual' },
  validFrom: '2026-08-01T00:00:00.000Z',
  validThrough: null,
  verifiedAt: '2026-08-01T00:00:00.000Z',
  lastSyncedAt: null,
});

const legacyRate = {
  pricingKey: 'legacy:claude-opus:2026-08',
  modelId: 'claude-opus-5',
  provider: 'anthropic',
  ratesUsdMicrosPerMillion: { input: 1, cachedRead: 1, output: 2 },
  verifiedAt: '2026-08-01',
  validFrom: '2026-08-01',
} as const;

const configuredSource = {
  id: 'openai-feed',
  provider: 'openai',
  url: 'https://pricing.example.test/openai.json',
} as const;

/** One in-memory document, so what actually reaches the disk is what the assertions read. */
function documentStore(initial?: string): {
  readonly store: FileDaemonConfig;
  text: () => string | undefined;
  set: (next: string) => void;
} {
  let text = initial;
  const files = {
    readText: async () => text,
    writeTextAtomic: async (_path: string, next: string) => {
      text = next;
    },
  } as Pick<FileSystemPort, 'readText' | 'writeTextAtomic'> as FileSystemPort;
  return {
    store: new FileDaemonConfig(paths, files),
    text: () => text,
    set: (next: string) => {
      text = next;
    },
  };
}

describe('FileDaemonConfig', () => {
  it('should persist private defaults once and reload an explicit configuration', async () => {
    // Arrange
    const documents = documentStore();

    // Act
    const created = await documents.store.load();
    documents.set(JSON.stringify({ host: 'localhost', port: 8_123 }));
    const loaded = await documents.store.load();

    // Assert
    should(created.publicUrl).equal(FY_DEFAULT_DAEMON_URL);
    should(loaded.publicUrl).equal('http://localhost:8123');
    should(loaded.bindUrl).equal('http://localhost:8123');
  });

  it('should never seed a derived address into the document an operator edits', async () => {
    // Arrange
    const documents = documentStore();

    // Act
    await documents.store.load();
    const seeded = JSON.parse(documents.text() ?? '{}') as Record<string, unknown>;

    // Assert — the defect this closes: the derived public URL was written back as though an operator
    // had chosen it, so it stopped tracking `port` and editing the port appeared to do nothing.
    should(seeded).not.have.property('publicUrl');
    should(seeded).not.have.property('bindUrl');
    should(seeded).not.have.property('port');
    // What IS seeded is still a usable document: defaults an operator can see and change.
    should(seeded).have.property('host', '127.0.0.1');
  });

  it('should record the address this daemon took and leave every other field alone', async () => {
    // Arrange: an operator has already set things in this document.
    const documents = documentStore(
      JSON.stringify({ host: '127.0.0.1', healthIntervalSeconds: 90, projectRoots: ['~/Code'] }),
    );

    // Act
    await documents.store.record(7_432);
    const recorded = await documents.store.load();
    const written = JSON.parse(documents.text() ?? '{}') as Record<string, unknown>;

    // Assert — recording is what makes choosing safe: the next boot binds exactly this or refuses.
    should(written).have.property('port', 7_432);
    should(recorded.portIsRecorded).be.true();
    should(recorded.bindUrl).equal('http://127.0.0.1:7432');
    // Exactly one key is written; the operator's own settings survive untouched.
    should(written).have.property('healthIntervalSeconds', 90);
    should(written).have.property('projectRoots', ['~/Code']);
    // And still nothing derived, so a recorded port cannot freeze an advertisement beside it.
    should(written).not.have.property('publicUrl');
    // EXACTLY ONE KEY, literally: the document that goes back to disk is the one that came off it,
    // plus `port`. A write that also planted every schema default would put values into a file the
    // operator never typed, which is the only evidence anything downstream has of what they chose.
    should(Object.keys(written)).deepEqual(['host', 'healthIntervalSeconds', 'projectRoots', 'port']);
  });

  it('should record a settled port into the bind carrier rather than the key it supersedes', async () => {
    // Arrange: an operator who has moved their bind into `carriers` and left the old key in place.
    const documents = documentStore(
      JSON.stringify({
        port: 7_431,
        carriers: [
          { kind: 'bind', host: 'box.lan' },
          { kind: 'relay', source: 'discovery' },
        ],
      }),
    );

    // Act
    await documents.store.record(7_432);
    const written = JSON.parse(documents.text() ?? '{}') as Record<string, unknown>;
    const reloaded = await documents.store.load();

    // Assert — writing `port` here would write a key with no effect on where this daemon listens,
    // which is the defect the carrier list exists to remove rather than reproduce.
    should(written).have.property('carriers', [
      // The operator's own relay entry comes back exactly as they wrote it. A write that filled in
      // `enabled` and `reconnectSeconds` would be this daemon typing lines into their file and then
      // reading them back as their decisions.
      { kind: 'bind', host: 'box.lan', port: 7_432 },
      { kind: 'relay', source: 'discovery' },
    ]);
    should(written).have.property('port', 7_431);
    should(Object.keys(written)).deepEqual(['port', 'carriers']);
    should(reloaded.bindUrl).equal('http://box.lan:7432');
    should(reloaded.carrierSet.bind).deepEqual({ kind: 'bind', host: 'box.lan', port: 7_432 });
  });

  it('should never accuse an operator of a legacy key that this daemon wrote itself', async () => {
    // THE ROUND TRIP IS THE TEST. `supersededCarrierKeys` reads key PRESENCE in the raw document, so
    // a `record()` that wrote schema defaults planted a `host` the operator never typed — and every
    // boot afterwards told them to go and delete a line that is not in their file.
    // Arrange
    const documents = documentStore(JSON.stringify({ carriers: [{ kind: 'bind', host: 'box.lan' }] }));

    // Act
    await documents.store.record(7_432);
    const settled = await documents.store.peek();

    // Assert
    should(settled.document).deepEqual({ carriers: [{ kind: 'bind', host: 'box.lan', port: 7_432 }] });
    should(supersededCarrierKeys({ rawDocument: settled.document ?? {}, carriers: settled.config.carriers })).deepEqual(
      [],
    );
  });

  it('should record a grant decision without typing a legacy key into the same file', async () => {
    // THE SETTINGS SURFACE IS THE OTHER DOOR TO THE SAME DEFECT. Persisting the schema's reading of
    // the document planted every default beside the operator's own keys, so turning one thing off
    // from the UI was enough to make a `host` line appear in their file — and the next boot read it
    // back at them as a key they had superseded and should go and delete.
    // Arrange
    const documents = documentStore(JSON.stringify({ carriers: [{ kind: 'bind', host: 'box.lan' }] }));

    // Act
    await documents.store.writeGrants({ ...DEFAULT_CAPABILITY_GRANTS, warden: { use: false, configure: false } });
    const written = JSON.parse(documents.text() ?? '{}') as Record<string, unknown>;
    const settled = await documents.store.peek();

    // Assert — one key added, nothing manufactured, the carrier entry exactly as it was written.
    should(Object.keys(written)).deepEqual(['carriers', 'grants']);
    should(written).have.property('carriers', [{ kind: 'bind', host: 'box.lan' }]);
    should((written.grants as Record<string, unknown>).warden).deepEqual({ use: false, configure: false });
    should(supersededCarrierKeys({ rawDocument: settled.document ?? {}, carriers: settled.config.carriers })).deepEqual(
      [],
    );
    // And the decision still reads back as the operator's own, which is the point of writing it.
    should((await documents.store.readGrants()).warden).deepEqual({ use: false, configure: false });
    should(await documents.store.writtenGrants()).containEql('warden');
  });

  it('should preserve both pricing and grants when their raw document writes interleave', async () => {
    // This is the production race in miniature. Pricing enters its read/decide/write transaction and
    // is held at the atomic rename. A grant write starts while that first writer is suspended. The
    // grant adapter must join the SAME executor, so it cannot read the stale document and later erase
    // the pricing key (or have its own key erased by the pricing rename).
    // Arrange
    let text = JSON.stringify({ projectRoots: ['~/Code'] });
    let reads = 0;
    let writes = 0;
    const firstWriteEntered = Promise.withResolvers<void>();
    const releaseFirstWrite = Promise.withResolvers<void>();
    const files = {
      readText: async () => {
        reads += 1;
        return text;
      },
      writeTextAtomic: async (_path: string, next: string) => {
        const position = writes;
        writes += 1;
        if (position === 0) {
          firstWriteEntered.resolve();
          await releaseFirstWrite.promise;
        }
        text = next;
      },
    } as Pick<FileSystemPort, 'readText' | 'writeTextAtomic'> as FileSystemPort;
    const mutations = new KeyedSerialExecutor();
    const store = new FileDaemonConfig(paths, files);
    const pricing = new AnalyticsPricingService(
      store,
      { read: async () => ({ kind: 'unreachable' }) },
      mutations,
      { now: () => SYNCED_AT },
      { next: () => 'preview-not-used' },
    );
    const grants = new ConfigGrantDocument(store, mutations);
    const rate = ManualAnalyticsPricingRateSchema.parse(manualRate());

    // Act: pricing has read twice (view + fresh write check) and is paused at its first write.
    const pricingWrite = pricing.patch({
      expectedCatalogFingerprint: analyticsPricingFingerprint([]),
      operations: [{ op: 'upsert', rate }],
    });
    await firstWriteEntered.promise;
    const grantWrite = grants.write({
      ...DEFAULT_CAPABILITY_GRANTS,
      warden: { use: false, configure: false },
    });
    const readsBeforePricingSettled = reads;
    releaseFirstWrite.resolve();
    const [view] = await Promise.all([pricingWrite, grantWrite]);
    const written = JSON.parse(text) as Record<string, unknown>;

    // Assert: without the shared barrier the grant call synchronously performs a third raw read here,
    // and the two delayed renames finish with one of these keys missing. Once pricing settles, grants
    // re-reads its result and both operator decisions survive in the exact raw document.
    should(readsBeforePricingSettled).equal(2);
    should(writes).equal(2);
    should(view.catalog).deepEqual([rate]);
    should(written.analyticsPricing).deepEqual([rate]);
    should((written.grants as Record<string, unknown>).warden).deepEqual({ use: false, configure: false });
    should(written.projectRoots).deepEqual(['~/Code']);
  });

  it('should read pricing defaults and provenance without writing them into the raw document', async () => {
    // Arrange — `enabled` and last-sync are omitted intentionally: their absence is provenance.
    const raw = { analyticsPricingSources: [configuredSource], projectRoots: ['~/Code'] };
    const documents = documentStore(JSON.stringify(raw));

    // Act
    const actual = await documents.store.readPricing();

    // Assert
    should(actual.kind).equal('read');
    if (actual.kind !== 'read') throw new Error('expected a readable pricing document');
    should(actual.configuration.catalog).deepEqual([]);
    should(actual.configuration.sources[0]).containDeep({
      ...configuredSource,
      enabled: true,
      lastSyncedAt: null,
    });
    should(JSON.parse(documents.text() ?? '{}')).deepEqual(raw);
  });

  it('should preserve untouched raw pricing rows and every unrelated explicit/default decision', async () => {
    // Arrange — the old rate spelling and omitted source defaults must survive an edit elsewhere.
    const removed = manualRate('remove');
    const raw = {
      carriers: [{ kind: 'bind', host: 'box.lan' }],
      analyticsPricing: [legacyRate, removed],
      analyticsPricingSources: [configuredSource],
    };
    const documents = documentStore(JSON.stringify(raw));
    const read = await documents.store.readPricing();
    if (read.kind !== 'read') throw new Error('expected a readable pricing document');
    const added = manualRate();

    // Act
    const actual = await documents.store.writePricing({
      catalog: [...read.configuration.catalog.filter(rate => rate.pricingKey !== removed.pricingKey), added],
      expectedCatalogFingerprint: analyticsPricingFingerprint(read.configuration.catalog),
      touchedPricingKeys: [removed.pricingKey, added.pricingKey],
    });
    const written = JSON.parse(documents.text() ?? '{}') as Record<string, unknown>;

    // Assert
    should(actual.kind).equal('written');
    should(written.analyticsPricing).deepEqual([legacyRate, added]);
    should(written.analyticsPricingSources).deepEqual([configuredSource]);
    should(written.carriers).deepEqual(raw.carriers);
    should(written).not.have.property('host');
    should(Object.keys(written)).deepEqual(['carriers', 'analyticsPricing', 'analyticsPricingSources']);
  });

  it('should reject a stale catalog without overwriting the concurrently authored document', async () => {
    // Arrange
    const documents = documentStore(JSON.stringify({ analyticsPricing: [] }));
    const before = await documents.store.readPricing();
    if (before.kind !== 'read') throw new Error('expected a readable pricing document');
    const concurrent = { analyticsPricing: [manualRate('concurrent')], projectRoots: ['~/New'] };
    documents.set(JSON.stringify(concurrent));

    // Act
    const actual = await documents.store.writePricing({
      catalog: [manualRate('mine')],
      expectedCatalogFingerprint: analyticsPricingFingerprint(before.configuration.catalog),
      touchedPricingKeys: ['mine'],
    });

    // Assert
    should(actual.kind).equal('stale_catalog');
    should(JSON.parse(documents.text() ?? '{}')).deepEqual(concurrent);
  });

  it('should reject changed source authority and an unknown source-sync target without writing', async () => {
    // Arrange
    const original = { analyticsPricingSources: [configuredSource], projectRoots: ['~/Original'] };
    const documents = documentStore(JSON.stringify(original));
    const before = await documents.store.readPricing();
    if (before.kind !== 'read') throw new Error('expected a readable pricing document');
    const changed = {
      analyticsPricingSources: [{ ...configuredSource, url: 'https://pricing.example.test/replaced.json' }],
      projectRoots: ['~/Concurrent'],
    };
    documents.set(JSON.stringify(changed));

    // Act
    const stale = await documents.store.writePricing({
      catalog: before.configuration.catalog,
      expectedCatalogFingerprint: analyticsPricingFingerprint(before.configuration.catalog),
      touchedPricingKeys: [],
      expectedSourcesFingerprint: analyticsPricingSourcesFingerprint(before.configuration.sources),
      syncedSource: { sourceId: configuredSource.id, lastSyncedAt: SYNCED_AT },
    });
    documents.set(JSON.stringify(original));
    const missing = await documents.store.writePricing({
      catalog: before.configuration.catalog,
      expectedCatalogFingerprint: analyticsPricingFingerprint(before.configuration.catalog),
      touchedPricingKeys: [],
      expectedSourcesFingerprint: analyticsPricingSourcesFingerprint(before.configuration.sources),
      syncedSource: { sourceId: 'not-configured', lastSyncedAt: SYNCED_AT },
    });

    // Assert
    should(stale.kind).equal('stale_sources');
    should(missing.kind).equal('stale_sources');
    should(JSON.parse(documents.text() ?? '{}')).deepEqual(original);
  });

  it('should stamp only the applied configured source and only the selected pricing rows', async () => {
    // Arrange
    const otherSource = {
      id: 'anthropic-feed',
      provider: 'anthropic',
      url: 'https://pricing.example.test/anthropic.json',
    } as const;
    const untouched = manualRate('untouched');
    const raw = {
      analyticsPricing: [untouched],
      analyticsPricingSources: [configuredSource, otherSource],
      projectRoots: ['~/Code'],
    };
    const documents = documentStore(JSON.stringify(raw));
    const before = await documents.store.readPricing();
    if (before.kind !== 'read') throw new Error('expected a readable pricing document');
    const synced: AnalyticsPricingRate = {
      ...manualRate('synced'),
      modelId: 'gpt-5-synced',
      source: { kind: 'provider_sync', provider: 'openai', sourceUrl: configuredSource.url },
      verifiedAt: SYNCED_AT,
      lastSyncedAt: SYNCED_AT,
    };

    // Act
    const actual = await documents.store.writePricing({
      catalog: [...before.configuration.catalog, synced],
      expectedCatalogFingerprint: analyticsPricingFingerprint(before.configuration.catalog),
      touchedPricingKeys: [synced.pricingKey],
      expectedSourcesFingerprint: analyticsPricingSourcesFingerprint(before.configuration.sources),
      syncedSource: { sourceId: configuredSource.id, lastSyncedAt: SYNCED_AT },
    });
    const written = JSON.parse(documents.text() ?? '{}') as Record<string, unknown>;

    // Assert
    should(actual.kind).equal('written');
    should(written.analyticsPricing).deepEqual([untouched, synced]);
    should(written.analyticsPricingSources).deepEqual([{ ...configuredSource, lastSyncedAt: SYNCED_AT }, otherSource]);
    should(written.projectRoots).deepEqual(['~/Code']);
    if (actual.kind !== 'written') throw new Error('expected a successful pricing write');
    should(actual.configuration.sources[0]).containDeep({ lastSyncedAt: SYNCED_AT });
  });

  it('should answer what is on disk without writing anything', async () => {
    // Arrange
    const fresh = documentStore();
    const written = documentStore(JSON.stringify({ host: '127.0.0.1', port: 7_432 }));

    // Act
    const nothingYet = await fresh.store.peek();
    const existing = await written.store.peek();

    // Assert — `--print-config` and `--check` read through this, and a question must never provision:
    // creating a state home as a side effect of asking is the `--version` defect all over again.
    should(nothingYet.document).be.undefined();
    should(fresh.text()).be.undefined();
    should(nothingYet.config.portIsRecorded).be.false();
    // The RAW document comes back beside the parsed one because provenance needs it: whether a value
    // was written down or defaulted is exactly the question, and the parsed form has lost it.
    should(existing.document).deepEqual({ host: '127.0.0.1', port: 7_432 });
    should(existing.config.bindUrl).equal('http://127.0.0.1:7432');
    // The document is named rather than described, so a refusal can point at the file to edit.
    should(fresh.store.path).equal(paths.daemonConfig);
  });

  it('should record into a state home whose document has not been written yet', async () => {
    // Arrange: the boot decides its address before anything else writes the document.
    const documents = documentStore();

    // Act
    await documents.store.record(7_433);

    // Assert
    should(JSON.parse(documents.text() ?? '{}')).have.property('port', 7_433);
  });
});

describe('a configuration document this daemon will not act on', () => {
  it('should name the FILE in every refusal rather than dumping a validation error', async () => {
    // Refusing is only half the contract. This already stopped the daemon — the schema is strict and
    // nothing falls back — but what reached the operator was a raw dump with no path in it, which is
    // the "non-zero exit that explains nothing" this package already corrected for occupied
    // addresses. The cause travels underneath, because the field name in it is the actual answer.
    // Arrange
    const unknownKey = documentStore(JSON.stringify({ grants: { kubernetes: { use: true } } }));
    const brokenJson = documentStore('{ not json');

    // Act
    const peeked = await unknownKey.store.peek().catch((error: unknown) => error);
    const loaded = await unknownKey.store.load().catch((error: unknown) => error);
    const grants = await unknownKey.store.readGrants().catch((error: unknown) => error);
    const written = await brokenJson.store.writtenGrants().catch((error: unknown) => error);
    const recorded = await brokenJson.store.record(7_431).catch((error: unknown) => error);

    // Assert — one sentence, one file, wherever the mistake is met.
    for (const raised of [peeked, loaded, grants, written, recorded]) {
      should(raised).be.instanceof(DaemonConfigDocumentError);
      should((raised as Error).message).match(/\/state\/config\/daemon\.json could not be read/u);
    }
    should((peeked as DaemonConfigDocumentError).cause).not.be.undefined();
  });

  it('should refuse to write grants over a document it could not read', async () => {
    // Rewriting a document this daemon does not understand would discard whatever the operator
    // actually wrote there — including the very field that is wrong, which is the one they need.
    // Arrange
    const documents = documentStore(JSON.stringify({ port: 'not a number' }));

    // Act
    const raised = await documents.store
      .writeGrants(DEFAULT_CAPABILITY_GRANTS)
      .then(() => undefined)
      .catch((error: unknown) => error);

    // Assert
    should(raised).be.instanceof(DaemonConfigDocumentError);
    should(documents.text()).equal(JSON.stringify({ port: 'not a number' }));
  });

  it('should return narrow pricing unavailability without overwriting the damaged evidence', async () => {
    // Arrange
    const original = JSON.stringify({ analyticsPricing: 'not a catalog' });
    const documents = documentStore(original);

    // Act
    const read = await documents.store.readPricing();
    const write = await documents.store.writePricing({
      catalog: [],
      expectedCatalogFingerprint: 'cannot-match',
      touchedPricingKeys: [],
    });

    // Assert
    should(read.kind).equal('unavailable');
    should(write.kind).equal('unavailable');
    should(documents.text()).equal(original);
  });
});
