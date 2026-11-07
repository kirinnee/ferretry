import { describe, expect, it } from 'bun:test';
import {
  bundledRelayDirectory,
  carrierDisclosure,
  HOSTED_RELAY_PATH,
  NO_RELAY_DIRECTORY,
  parseHostedRelayAdvertisement,
  readHostedRelayFallback,
} from '../../../app/hosted-relay.ts';

const answering =
  (body: unknown, status = 200) =>
  async (_input: string) =>
    new Response(JSON.stringify(body), { status });

describe('the hosted relay advertisement', () => {
  it('is available only for a version-1 document carrying one dialable address', () => {
    expect(parseHostedRelayAdvertisement({ version: 1, relayUrl: 'https://relay.example.invalid/' })).toEqual({
      kind: 'available',
      relayUrl: 'https://relay.example.invalid',
    });
    expect(parseHostedRelayAdvertisement({ version: 1, relayUrl: 'wss://relay.example.invalid/ws' })).toEqual({
      kind: 'available',
      relayUrl: 'wss://relay.example.invalid/ws',
    });
  });

  it('null is the operator switch: disabled, not undetermined', () => {
    expect(parseHostedRelayAdvertisement({ version: 1, relayUrl: null })).toEqual({ kind: 'disabled' });
  });

  it('refuses plaintext off loopback, a query, a fragment and any other version', () => {
    for (const relayUrl of [
      'http://relay.example.invalid',
      'ws://relay.example.invalid',
      'https://relay.example.invalid/?x=1',
      'https://relay.example.invalid/#x',
      'not a url',
      'ftp://relay.example.invalid',
    ])
      expect(parseHostedRelayAdvertisement({ version: 1, relayUrl }).kind).toBe('undetermined');
    expect(parseHostedRelayAdvertisement({ version: 2, relayUrl: 'https://relay.example.invalid' }).kind).toBe(
      'undetermined',
    );
    for (const value of [null, 'x', [], 7, {}, { version: 1 }, { version: 1, relayUrl: 5 }])
      expect(parseHostedRelayAdvertisement(value).kind).toBe('undetermined');
  });

  it('allows plaintext against loopback, where nobody else is on the path', () => {
    for (const relayUrl of [
      'http://localhost:8787',
      'ws://127.0.0.1:8787',
      'http://[::1]:8787',
      'http://app.localhost',
    ])
      expect(parseHostedRelayAdvertisement({ version: 1, relayUrl }).kind).toBe('available');
  });
});

describe('reading the advertisement', () => {
  it('asks <directory>/v1/default-relay with no-store and answers what it says', async () => {
    const seen: { url: string; cache: string | undefined }[] = [];
    const fetcher = async (url: string, init?: RequestInit) => {
      seen.push({ url, cache: init?.cache });
      return new Response(JSON.stringify({ version: 1, relayUrl: 'https://relay.example.invalid' }));
    };
    const result = await readHostedRelayFallback({ directoryUrl: 'https://directory.example.invalid/', fetcher });
    expect(result).toEqual({ kind: 'available', relayUrl: 'https://relay.example.invalid' });
    expect(seen).toEqual([{ url: `https://directory.example.invalid${HOSTED_RELAY_PATH}`, cache: 'no-store' }]);
  });

  it('asks nothing when the build has no directory, and says so', async () => {
    const fetcher = async () => {
      throw new Error('must not be asked');
    };
    expect(await readHostedRelayFallback({ fetcher })).toBe(NO_RELAY_DIRECTORY);
  });

  it('never throws: every failure is an undetermined answer with its reason', async () => {
    const directoryUrl = 'https://directory.example.invalid';
    const refused = await readHostedRelayFallback({
      directoryUrl,
      fetcher: async () => {
        throw new Error('offline');
      },
    });
    expect(refused).toEqual({ kind: 'undetermined', reason: 'this page could not reach the relay directory' });
    expect(await readHostedRelayFallback({ directoryUrl, fetcher: answering({}, 503) })).toEqual({
      kind: 'undetermined',
      reason: 'the relay directory answered 503',
    });
    const notJson = await readHostedRelayFallback({ directoryUrl, fetcher: async () => new Response('<html>') });
    expect(notJson.kind).toBe('undetermined');
    const badDirectory = await readHostedRelayFallback({
      directoryUrl: 'http://plain.example.invalid',
      fetcher: answering({}),
    });
    expect(badDirectory).toEqual({
      kind: 'undetermined',
      reason: 'the configured relay directory is not an address this browser may ask',
    });
  });

  it('has no bundled directory unless the build defines one', () => {
    expect(bundledRelayDirectory()).toBeUndefined();
  });

  it('the disclosure names the carrier order and what the fallback would see', () => {
    const disclosure = carrierDisclosure();
    expect(disclosure.fallbackName).toBe('the hosted relay');
    expect(disclosure.inUse).toContain('directly first, then the hosted relay');
    expect(disclosure.fallbackWouldSee).toHaveLength(3);
  });
});
