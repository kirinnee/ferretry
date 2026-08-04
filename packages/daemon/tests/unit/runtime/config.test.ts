import { describe, it } from 'bun:test';
import should from 'should';
import { defaultDaemonConfig, parseDaemonConfig } from '../../../src/lib/runtime/config.ts';

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
      publicUrl: 'http://127.0.0.1:7337',
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
    should(() => parseDaemonConfig({ host: 'localhost', port: 7337, unknown: true })).throw();
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
