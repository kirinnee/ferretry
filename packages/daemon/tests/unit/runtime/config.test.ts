import { describe, it } from 'bun:test';
import should from 'should';
import { FY_DEFAULT_DAEMON_PORT } from '@ferretry/protocol';
import { DISCOVERED_RELAY_CARRIER } from '../../../src/lib/runtime/carriers.ts';
import {
  advertisesForeignAddress,
  configuredAt,
  defaultDaemonConfig,
  defaultDaemonConfigDocument,
  overriddenBy,
  parseDaemonConfig,
  recordedPortDocument,
} from '../../../src/lib/runtime/config.ts';

const pricingRate = (patch: Record<string, unknown> = {}) => ({
  pricingKey: 'operator:model-a:2026-08',
  modelId: 'model-a',
  aliases: [],
  provider: 'openai',
  ratesUsdMicrosPerMillion: { input: 1, cachedRead: 1, output: 1 },
  verifiedAt: '2026-08-01T00:00:00.000Z',
  validFrom: '2026-08-01T00:00:00.000Z',
  ...patch,
});

describe('daemon configuration', () => {
  it('should derive a local public URL while rejecting unsafe host and port values', () => {
    // Act + Assert
    should(defaultDaemonConfig()).containDeep({
      host: '127.0.0.1',
      publicUrl: `http://127.0.0.1:${String(FY_DEFAULT_DAEMON_PORT)}`,
      advertisement: {
        kind: 'local-only',
        url: `http://127.0.0.1:${String(FY_DEFAULT_DAEMON_PORT)}`,
      },
      corsOrigins: ['https://ferretry.pages.dev'],
    });
    should(parseDaemonConfig({ host: 'localhost', port: 9000 })).containDeep({
      publicUrl: 'http://localhost:9000',
      advertisement: { kind: 'local-only', url: 'http://localhost:9000' },
    });
    should(parseDaemonConfig({ projectRoots: ['~/Work'] }).projectRoots).deepEqual(['~/Work']);
    should(
      parseDaemonConfig({
        analyticsPricing: [
          {
            pricingKey: 'operator:claude-opus-5:2026-08',
            modelId: 'claude-opus-5',
            aliases: ['opus-5'],
            provider: 'anthropic',
            ratesUsdMicrosPerMillion: {
              input: 15_000_000,
              cachedRead: 1_500_000,
              cacheWrite5m: 18_750_000,
              cacheWrite1h: 30_000_000,
              output: 75_000_000,
            },
            verifiedAt: '2026-08-01T00:00:00.000Z',
            validFrom: '2026-08-01T00:00:00.000Z',
          },
        ],
      }).analyticsPricing,
    ).deepEqual([
      {
        pricingKey: 'operator:claude-opus-5:2026-08',
        modelId: 'claude-opus-5',
        aliases: ['opus-5'],
        provider: 'anthropic',
        ratesUsdMicrosPerMillion: {
          input: 15_000_000,
          cachedRead: 1_500_000,
          cacheWrite5m: 18_750_000,
          cacheWrite1h: 30_000_000,
          output: 75_000_000,
        },
        verifiedAt: '2026-08-01T00:00:00.000Z',
        validFrom: '2026-08-01T00:00:00.000Z',
      },
    ]);
    should(parseDaemonConfig({ corsOrigins: ['https://example.test/'] }).corsOrigins).deepEqual([
      'https://example.test',
    ]);
    should(() =>
      parseDaemonConfig({
        analyticsPricing: [
          {
            pricingKey: 'same',
            modelId: 'model-a',
            aliases: [],
            provider: 'openai',
            ratesUsdMicrosPerMillion: { input: 1, cachedRead: 1, output: 1 },
            verifiedAt: '2026-08-01T00:00:00.000Z',
            validFrom: '2026-08-01T00:00:00.000Z',
          },
          {
            pricingKey: 'same',
            modelId: 'model-b',
            aliases: [],
            provider: 'openai',
            ratesUsdMicrosPerMillion: { input: 1, cachedRead: 1, output: 1 },
            verifiedAt: '2026-08-01T00:00:00.000Z',
            validFrom: '2026-08-01T00:00:00.000Z',
          },
        ],
      }),
    ).throw();
    should(() => parseDaemonConfig({ corsOrigins: ['https://example.test/path'] })).throw();
    should(() => parseDaemonConfig({ host: '', port: 0 })).throw();
    should(() => parseDaemonConfig({ host: 'localhost', port: 7431, unknown: true })).throw();
  });

  it('should never write a derived address into the document an operator edits', () => {
    // The defect: the derived public URL was persisted as though an operator had chosen it, after
    // which it stopped tracking `port` — so editing the port moved the bind and left everything that
    // reads the advertised address behind, and the edit appeared to do nothing at all.
    const document = defaultDaemonConfigDocument();

    // Assert
    should(document).not.have.property('publicUrl');
    should(document).not.have.property('bindUrl');
    // Nor the port: an unrecorded port is a preference this daemon may move off, and writing the
    // default out would freeze it into a claim before anything had tried to bind it.
    should(document).not.have.property('port');
    // Serialization is what actually reaches the disk, so assert on that rather than the object.
    should(JSON.parse(JSON.stringify(document))).not.have.property('publicUrl');
  });

  it('should tell a recorded port from a preferred one, because only one of them may move', () => {
    // Act
    const unrecorded = parseDaemonConfig({});
    const recorded = parseDaemonConfig({ port: 9100 });

    // Assert
    should(unrecorded.portIsRecorded).be.false();
    should(unrecorded.port).equal(FY_DEFAULT_DAEMON_PORT);
    should(recorded.portIsRecorded).be.true();
    should(recorded.bindUrl).equal('http://127.0.0.1:9100');
  });

  it('should move a derived advertisement with the port and leave a stated one alone', () => {
    // Arrange
    const derived = parseDaemonConfig({});
    const stated = parseDaemonConfig({ publicUrl: 'https://box.example.test' });

    // Act
    const movedDerived = configuredAt(derived, 9200);
    const movedStated = configuredAt(stated, 9200);

    // Assert — a derived advertisement that stayed behind IS the defect; an operator's own one is a
    // proxy or a tunnel they meant, and moving it would break the deployment they described.
    should(movedDerived.bindUrl).equal('http://127.0.0.1:9200');
    should(movedDerived.publicUrl).equal('http://127.0.0.1:9200');
    should(movedDerived.advertisement).deepEqual({ kind: 'local-only', url: 'http://127.0.0.1:9200' });
    should(advertisesForeignAddress(movedDerived)).be.false();
    should(movedStated.bindUrl).equal('http://127.0.0.1:9200');
    should(movedStated.publicUrl).equal('https://box.example.test');
    should(movedStated.advertisement).deepEqual({
      kind: 'address',
      url: 'https://box.example.test',
      origin: 'operator',
    });
    should(advertisesForeignAddress(movedStated)).be.true();
    // Settling on the port already loaded still records the claim, so the next boot cannot move.
    should(configuredAt(derived, derived.port).portIsRecorded).be.true();
    should(configuredAt(derived, derived.port).bindUrl).equal(derived.bindUrl);
  });

  it('should let one run override the document without turning the override into a claim on disk', () => {
    // Arrange
    const document = parseDaemonConfig({ host: '127.0.0.1' });
    const advertised = parseDaemonConfig({ publicUrl: 'https://box.example.test' });

    // Act
    const nothingSaid = overriddenBy(document, {});
    const portOnly = overriddenBy(document, { port: 9_100 });
    const both = overriddenBy(document, { host: '0.0.0.0', port: 9_100 });
    const withAdvertisement = overriddenBy(advertised, { port: 9_100 });

    // Assert — an untouched run is the very same object; nothing is rebuilt for nothing.
    should(nothingSaid).equal(document);
    // A port named on the command line is a CLAIM: it is bound or it fails, never silently moved.
    should(portOnly.bindUrl).equal('http://127.0.0.1:9100');
    should(portOnly.portIsRecorded).be.true();
    should(both.bindUrl).equal('http://0.0.0.0:9100');
    should(both.host).equal('0.0.0.0');
    // A derived advertisement follows the override; an operator's own one is left where they put it.
    should(portOnly.publicUrl).equal('http://127.0.0.1:9100');
    should(portOnly.advertisement).deepEqual({ kind: 'local-only', url: 'http://127.0.0.1:9100' });
    should(both.advertisement).deepEqual({ kind: 'none', refusal: 'wildcard-bind' });
    should(withAdvertisement.publicUrl).equal('https://box.example.test');
    should(withAdvertisement.advertisement).deepEqual({
      kind: 'address',
      url: 'https://box.example.test',
      origin: 'operator',
    });
    // Overriding only the host keeps the document's port rather than inventing one.
    should(overriddenBy(parseDaemonConfig({ port: 8_080 }), { host: 'localhost' }).bindUrl).equal(
      'http://localhost:8080',
    );
  });

  it('should apply the same advertisement decision on load, port settlement, and run override', () => {
    // The three daemon derivation paths used to each spell `publicUrl ?? bindUrl`, while the client
    // had a fourth copy. A fix in only one path would work until the port moved or a flag was used.
    const loaded = parseDaemonConfig({ host: '192.168.1.10', port: 7_431 });
    const settled = configuredAt(parseDaemonConfig({ host: '192.168.1.10' }), 7_432);
    const overridden = overriddenBy(parseDaemonConfig({}), { host: '192.168.1.10', port: 7_433 });

    should(loaded.advertisement).deepEqual({
      kind: 'address',
      url: 'http://192.168.1.10:7431',
      origin: 'derived',
    });
    should(settled.advertisement).deepEqual({
      kind: 'address',
      url: 'http://192.168.1.10:7432',
      origin: 'derived',
    });
    should(overridden.advertisement).deepEqual({
      kind: 'address',
      url: 'http://192.168.1.10:7433',
      origin: 'derived',
    });
  });

  it('should never call a wildcard bind’s advertisement foreign, because that pairing is the remedy', () => {
    /*
     * THE NOTICE THAT TOLD SOMEBODY TO UNDO THE FIX. Pairing's remedy for a daemon no phone can
     * reach asks for exactly this pair — bind every interface, advertise the one address a device
     * can dial. A wildcard is a bind instruction rather than a destination, so comparing it with
     * that advertisement finds them different every single time, and the boot then printed "if that
     * is not deliberate, remove publicUrl" at an operator who had just deliberately added it.
     */
    // Arrange
    const remedied = parseDaemonConfig({ host: '0.0.0.0', port: 7_431, publicUrl: 'http://192.168.1.10:7431' });
    const proxied = parseDaemonConfig({ host: '127.0.0.1', port: 7_431, publicUrl: 'https://box.example.test' });
    const wildcardAlone = parseDaemonConfig({ host: '::', port: 7_431 });

    // Assert — the wildcard cases say nothing; a real proxy deployment is still stated as the fact it is.
    should(advertisesForeignAddress(remedied)).be.false();
    should(advertisesForeignAddress(wildcardAlone)).be.false();
    should(advertisesForeignAddress(proxied)).be.true();
    // And the advertisement itself is unchanged by any of this: the operator's address, verbatim.
    should(remedied.advertisement).deepEqual({
      kind: 'address',
      url: 'http://192.168.1.10:7431',
      origin: 'operator',
    });
  });

  it('should refuse damaged or ambiguous pricing evidence before the daemon can use it', () => {
    // A catalog cannot name two prices for the same effective model instant, and an alias must never
    // be allowed to resolve to two models. Either condition would otherwise make a plausible amount
    // depend on incidental catalog order.
    should(() =>
      parseDaemonConfig({ analyticsPricing: [pricingRate({ validThrough: '2026-07-31T23:59:59.000Z' })] }),
    ).throw();
    should(() =>
      parseDaemonConfig({
        analyticsPricing: [
          pricingRate(),
          pricingRate({ pricingKey: 'operator:model-a:second', aliases: ['model-a-alias'] }),
        ],
      }),
    ).throw();
    should(() =>
      parseDaemonConfig({
        analyticsPricing: [
          pricingRate({ aliases: ['shared-alias'] }),
          pricingRate({
            pricingKey: 'operator:model-b:2026-08',
            modelId: 'model-b',
            aliases: ['shared-alias'],
            validFrom: '2026-08-02T00:00:00.000Z',
          }),
        ],
      }),
    ).throw();
  });
});

describe('the carriers a document declares', () => {
  it('should read the legacy keys as the one bind and one relay they always were', () => {
    // Act
    const legacy = parseDaemonConfig({ host: 'box.lan', port: 9_100, relay: { url: 'wss://relay.example' } });

    // Assert — the legacy spelling is not a second mechanism, it is this list written the old way.
    should(legacy.carrierSet).deepEqual({
      bind: { kind: 'bind', host: 'box.lan', port: 9_100 },
      relays: [{ kind: 'relay', url: 'wss://relay.example', enabled: true, reconnectSeconds: 5 }],
    });
    should(legacy.bindUrl).equal('http://box.lan:9100');
    // A document that names no rendezvous at all still asks the directory, because a daemon that
    // dialled nowhere would be reachable from nothing but its own host.
    should(defaultDaemonConfig().carrierSet).deepEqual({
      bind: { kind: 'bind', host: '127.0.0.1', port: FY_DEFAULT_DAEMON_PORT },
      relays: [DISCOVERED_RELAY_CARRIER],
    });
    should(defaultDaemonConfig().portIsRecorded).be.false();
  });

  it('should let an explicit bind carrier decide where this daemon listens', () => {
    // Arrange + Act: both spellings present, so the new one has to be the one that lands.
    const config = parseDaemonConfig({
      host: '127.0.0.1',
      port: 7_431,
      carriers: [{ kind: 'bind', host: '192.168.1.10', port: 9_200 }],
    });

    // Assert — a superseded key that still moved the socket would be the defect, not the feature.
    should(config.host).equal('192.168.1.10');
    should(config.port).equal(9_200);
    should(config.bindUrl).equal('http://192.168.1.10:9200');
    should(config.publicUrl).equal('http://192.168.1.10:9200');
    should(config.advertisement).deepEqual({
      kind: 'address',
      url: 'http://192.168.1.10:9200',
      origin: 'derived',
    });
    should(config.portIsRecorded).be.true();
    should(config.carrierSet.bind).deepEqual({ kind: 'bind', host: '192.168.1.10', port: 9_200 });
  });

  it('should treat a bind carrier with no port as the preference an absent legacy port is', () => {
    // A bind that names no port means the same thing the legacy key's absence means: this daemon may
    // choose, once, and write the answer down — so the superseded `port` must not leak back in.
    const config = parseDaemonConfig({ port: 9_300, carriers: [{ kind: 'bind', host: 'box.lan' }] });

    // Assert
    should(config.port).equal(FY_DEFAULT_DAEMON_PORT);
    should(config.portIsRecorded).be.false();
    should(config.carrierSet.bind).deepEqual({ kind: 'bind', host: 'box.lan', port: FY_DEFAULT_DAEMON_PORT });
  });

  it('should supersede a legacy key per kind rather than wholesale', () => {
    // Somebody midway through the migration — relays moved over, `host` and `port` still at the top —
    // gets both read, which is the only reading that does not silently move where their daemon listens.
    const config = parseDaemonConfig({
      host: 'box.lan',
      port: 9_100,
      relay: { url: 'wss://legacy.example' },
      carriers: [
        { kind: 'relay', url: 'wss://new.example' },
        { kind: 'relay', source: 'discovery' },
      ],
    });

    // Assert
    should(config.carrierSet.bind).deepEqual({ kind: 'bind', host: 'box.lan', port: 9_100 });
    should(config.carrierSet.relays).deepEqual([
      { kind: 'relay', url: 'wss://new.example', enabled: true, reconnectSeconds: 5 },
      DISCOVERED_RELAY_CARRIER,
    ]);
    // The legacy block stays readable as itself; it is superseded, not deleted out from under anyone.
    should(config.relay).deepEqual({ url: 'wss://legacy.example', enabled: true, reconnectSeconds: 5 });
  });

  it('should hold a hand-edited list to the same bounds a command is', () => {
    // A daemon has one listening socket, and an operator who declared five rendezvous meant something
    // by the fifth — quietly serving four of them is a daemon lying about its own reach.
    should(() =>
      parseDaemonConfig({
        carriers: [
          { kind: 'bind', host: '127.0.0.1' },
          { kind: 'bind', host: 'box.lan' },
        ],
      }),
    ).throw();
    should(() =>
      parseDaemonConfig({
        carriers: Array.from({ length: 5 }, (_, index) => ({
          kind: 'relay',
          url: `https://relay-${String(index)}.example`,
        })),
      }),
    ).throw();
    should(() => parseDaemonConfig({ carriers: [{ kind: 'bind' }] })).throw();
    should(() => parseDaemonConfig({ carriers: [{ kind: 'relay', url: 'http://relay.example' }] })).throw();
  });

  it('should keep the effective bind coherent when a port settles or a run overrides it', () => {
    // Arrange
    const declared = parseDaemonConfig({
      carriers: [
        { kind: 'bind', host: 'box.lan' },
        { kind: 'relay', url: 'wss://relay.example' },
      ],
    });

    // Act
    const settled = configuredAt(declared, 9_400);
    const overridden = overriddenBy(declared, { host: '0.0.0.0', port: 9_500 });

    // Assert — the resolved set is what every later stage reads, so an address that moved and a set
    // that did not would put the two back into the disagreement this whole shape removes.
    should(settled.carrierSet.bind).deepEqual({ kind: 'bind', host: 'box.lan', port: 9_400 });
    should(settled.bindUrl).equal('http://box.lan:9400');
    should(settled.carrierSet.relays).deepEqual(declared.carrierSet.relays);
    should(overridden.carrierSet.bind).deepEqual({ kind: 'bind', host: '0.0.0.0', port: 9_500 });
    should(overridden.bindUrl).equal('http://0.0.0.0:9500');
    should(overridden.carrierSet.relays).deepEqual(declared.carrierSet.relays);
    // Settling on the port already in hand records the claim and leaves the set exactly as it was.
    should(configuredAt(declared, declared.port).carrierSet).deepEqual(declared.carrierSet);
  });
});

describe('the document a settled port is written into', () => {
  it('should write the port into the bind carrier that supersedes the legacy key', () => {
    // Arrange — the RAW document, as the operator typed it and as it sits on disk.
    const document = {
      port: 7_431,
      carriers: [
        { kind: 'bind', host: 'box.lan' },
        { kind: 'relay', source: 'discovery' },
      ],
    };

    // Act
    const recorded = recordedPortDocument(document, 9_600);

    // Assert — recording into the superseded key is the exact defect this module exists to prevent:
    // a field an operator can watch change with no error, no message and no change in behaviour.
    // And EXACTLY ONE VALUE MOVES: no default is materialized anywhere, the operator's own relay
    // entry included, because key presence in this document is what a superseded-key report reads.
    should(recorded).deepEqual({
      port: 7_431,
      carriers: [
        { kind: 'bind', host: 'box.lan', port: 9_600 },
        { kind: 'relay', source: 'discovery' },
      ],
    });
  });

  it('should record the legacy key when no bind carrier was declared', () => {
    // Act + Assert — the legacy spelling is still a bind, so it is still where a settled port
    // belongs, and a relay-only list is not a bind.
    should(recordedPortDocument({ host: 'box.lan' }, 9_700)).deepEqual({ host: 'box.lan', port: 9_700 });
    should(recordedPortDocument({ carriers: [{ kind: 'relay', source: 'discovery' }] }, 9_700)).deepEqual({
      carriers: [{ kind: 'relay', source: 'discovery' }],
      port: 9_700,
    });
    // A port already written is replaced rather than doubled, and nothing beside it is touched.
    should(recordedPortDocument({ host: 'box.lan', port: 7_431, healthIntervalSeconds: 90 }, 9_700)).deepEqual({
      host: 'box.lan',
      port: 9_700,
      healthIntervalSeconds: 90,
    });
  });

  it('should read the document as the operator wrote it rather than as a schema would fill it', () => {
    // A `carriers` value that is not a list of entries is a document the configuration parse refuses
    // before a boot can settle anything — this stays total anyway, and invents no shape nobody wrote.
    should(recordedPortDocument({ carriers: 'nonsense' }, 9_800)).deepEqual({
      carriers: 'nonsense',
      port: 9_800,
    });
    should(recordedPortDocument({ carriers: [null, 'bind'] }, 9_800)).deepEqual({
      carriers: [null, 'bind'],
      port: 9_800,
    });
  });
});

describe('the relay carrier block', () => {
  it('should default to no carrier and refuse an address it could not sign for', () => {
    // Assert — an absent block is no carrier, never the address everybody else uses.
    should(defaultDaemonConfig().relay).be.undefined();
    should(parseDaemonConfig({ relay: { url: 'https://relay.example' } }).relay).deepEqual({
      url: 'https://relay.example',
      enabled: true,
      reconnectSeconds: 5,
    });
    should(
      parseDaemonConfig({ relay: { url: 'wss://relay.example/', enabled: false, reconnectSeconds: 45 } }).relay,
    ).deepEqual({ url: 'wss://relay.example', enabled: false, reconnectSeconds: 45 });
    // A loopback rendezvous is the one insecure address allowed, because that is the line the
    // published site's content-security-policy already draws.
    should(parseDaemonConfig({ relay: { url: 'http://127.0.0.1:8787' } }).relay?.url).equal('http://127.0.0.1:8787');
    should(() => parseDaemonConfig({ relay: { url: 'http://relay.example' } })).throw();
    should(() => parseDaemonConfig({ relay: { url: 'https://relay.example?tenant=a' } })).throw();
    should(() => parseDaemonConfig({ relay: { url: 'https://relay.example', reconnectSeconds: 0 } })).throw();
    should(() => parseDaemonConfig({ relay: { url: 'https://relay.example', unknown: true } })).throw();
  });
});
