import { describe, it } from 'bun:test';
import should from 'should';
import { FY_DEFAULT_DAEMON_PORT } from '@ferretry/protocol';
import {
  advertisesForeignAddress,
  configuredAt,
  defaultDaemonConfig,
  defaultDaemonConfigDocument,
  overriddenBy,
  parseDaemonConfig,
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
      corsOrigins: ['https://ferretry.pages.dev'],
    });
    should(parseDaemonConfig({ host: 'localhost', port: 9000 })).containDeep({ publicUrl: 'http://localhost:9000' });
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
    should(advertisesForeignAddress(movedDerived)).be.false();
    should(movedStated.bindUrl).equal('http://127.0.0.1:9200');
    should(movedStated.publicUrl).equal('https://box.example.test');
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
    should(withAdvertisement.publicUrl).equal('https://box.example.test');
    // Overriding only the host keeps the document's port rather than inventing one.
    should(overriddenBy(parseDaemonConfig({ port: 8_080 }), { host: 'localhost' }).bindUrl).equal(
      'http://localhost:8080',
    );
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
