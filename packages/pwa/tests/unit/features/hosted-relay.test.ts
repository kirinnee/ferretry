/**
 * The fallback carrier is a runtime fact, and reading it wrong is the bug.
 *
 * Three answers matter — available, switched off, and "this page does not know" —
 * and the whole value of this module is that the third is never quietly folded
 * into one of the other two. Reading a damaged or unreachable directory as
 * "available" promises a carrier that may not exist; reading it as "disabled"
 * blames an operator who did nothing. Both are the benign reading of missing
 * evidence, so both are tested against.
 *
 * The contract itself is `docs/relay-protocol.md` §13 and is not ours to invent,
 * so the shapes below are the document's shapes.
 */

import { describe, expect, it } from 'bun:test';

import {
  bundledRelayDirectory,
  CARRIER_ORDER_NOTE,
  CHECKING_HOSTED_RELAY,
  HOSTED_RELAY_ADVERTISEMENT_VERSION,
  HOSTED_RELAY_DISABLED_NOTE,
  HOSTED_RELAY_DISCLOSURE,
  HOSTED_RELAY_PATH,
  HOSTED_RELAY_UNDETERMINED_NOTE,
  type HostedRelayFetch,
  NO_RELAY_DIRECTORY,
  parseHostedRelayAdvertisement,
  readHostedRelayFallback,
  TRANSPORT_NOT_WIRED_NOTE,
} from '../../../src/features/onboarding/hosted-relay.ts';

const DIRECTORY = 'https://relay-directory.example.test';

const advertisement = (relayUrl: unknown): unknown => ({ version: HOSTED_RELAY_ADVERTISEMENT_VERSION, relayUrl });

/** A fetcher that records what was asked for and answers with one canned response. */
const answering = (response: Response | Error): { readonly asked: string[]; readonly fetch: HostedRelayFetch } => {
  const asked: string[] = [];
  return {
    asked,
    fetch: async (input, init) => {
      asked.push(`${input} ${init?.cache ?? ''}`.trim());
      if (response instanceof Error) throw response;
      return response;
    },
  };
};

describe('parseHostedRelayAdvertisement', () => {
  it('reads an advertised address, normalised the way the protocol normalises it', () => {
    expect(parseHostedRelayAdvertisement(advertisement('https://relay.example.test'))).toEqual({
      kind: 'available',
      relayUrl: 'https://relay.example.test',
    });
    // A trailing slash is the same endpoint, and `docs/relay-protocol.md` strips it.
    expect(parseHostedRelayAdvertisement(advertisement('https://relay.example.test/'))).toEqual({
      kind: 'available',
      relayUrl: 'https://relay.example.test',
    });
    expect(parseHostedRelayAdvertisement(advertisement('wss://relay.example.test'))).toEqual({
      kind: 'available',
      relayUrl: 'wss://relay.example.test',
    });
    // Insecure only against loopback — the same line the page's own CSP draws.
    expect(parseHostedRelayAdvertisement(advertisement('http://127.0.0.1:8787'))).toEqual({
      kind: 'available',
      relayUrl: 'http://127.0.0.1:8787',
    });
  });

  it('treats null as the kill switch, which is a fact and not an absence', () => {
    // The operator can switch the default off without an app release. That is
    // "disabled", and it is not the same as an address this page failed to read.
    expect(parseHostedRelayAdvertisement(advertisement(null))).toEqual({ kind: 'disabled' });
  });

  it('says it does not know, rather than guessing, for everything else', () => {
    const damaged: readonly unknown[] = [
      null,
      undefined,
      'https://relay.example.test',
      [advertisement(null)],
      {},
      { version: 2, relayUrl: 'https://relay.example.test' },
      { version: '1', relayUrl: 'https://relay.example.test' },
      advertisement(undefined),
      advertisement(7),
      // Not a URL, an insecure scheme off loopback, and a query or fragment on a
      // socket address: each is a sign the value is not what its sender thought.
      advertisement('relay.example.test'),
      advertisement('http://relay.example.test'),
      advertisement('ws://relay.example.test'),
      advertisement('https://relay.example.test?token=x'),
      advertisement('https://relay.example.test#frag'),
      advertisement(`https://relay.example.test/${'x'.repeat(2_100)}`),
    ];
    for (const value of damaged) {
      const answer = parseHostedRelayAdvertisement(value);
      expect(answer.kind).toBe('undetermined');
      // The reason is shown to a reader, so it has to be a sentence, not a code.
      if (answer.kind === 'undetermined') expect(answer.reason.length).toBeGreaterThan(8);
    }
  });
});

describe('readHostedRelayFallback', () => {
  it('asks the documented path on the origin it was GIVEN, never one of its own', async () => {
    const { asked, fetch } = answering(Response.json(advertisement('https://relay.example.test')));

    expect(await readHostedRelayFallback({ directoryUrl: DIRECTORY, fetcher: fetch })).toEqual({
      kind: 'available',
      relayUrl: 'https://relay.example.test',
    });
    expect(HOSTED_RELAY_PATH).toBe('/v1/default-relay');
    // The origin came from the caller. Nothing in this module supplies one, so a
    // bundle anyone can fetch carries no relay address at all.
    expect(asked).toEqual([`${DIRECTORY}${HOSTED_RELAY_PATH} no-store`]);
  });

  it('makes NO request at all when this build has no directory', async () => {
    // The state production is in. A relative path would not reach the hosted
    // Worker — it is a separate origin, and no Pages route to it exists — so
    // asking anyway would fetch this app's own HTML and call it an answer.
    const { asked, fetch } = answering(Response.json(advertisement('https://relay.example.test')));

    expect(await readHostedRelayFallback({ fetcher: fetch })).toEqual(NO_RELAY_DIRECTORY);
    expect(asked).toEqual([]);
    expect(NO_RELAY_DIRECTORY.kind).toBe('undetermined');
  });

  it('refuses a configured directory that is not an address it may ask', async () => {
    const { asked, fetch } = answering(Response.json(advertisement(null)));
    const answer = await readHostedRelayFallback({ directoryUrl: 'http://relay.example.test', fetcher: fetch });

    expect(answer.kind).toBe('undetermined');
    if (answer.kind === 'undetermined') expect(answer.reason).toContain('not an address');
    expect(asked).toEqual([]);
  });

  it('answers rather than throwing when the directory is unreachable', async () => {
    // A rejected promise here would take a setup screen down over a carrier the
    // reader may not even need.
    const { fetch } = answering(new Error('connection refused'));
    const answer = await readHostedRelayFallback({ directoryUrl: DIRECTORY, fetcher: fetch });
    expect(answer.kind).toBe('undetermined');
    if (answer.kind === 'undetermined') expect(answer.reason).toContain('could not reach');
  });

  it('does not read an error page as an answer', async () => {
    const { fetch } = answering(new Response('gone', { status: 503 }));
    const answer = await readHostedRelayFallback({ directoryUrl: DIRECTORY, fetcher: fetch });
    expect(answer.kind).toBe('undetermined');
    if (answer.kind === 'undetermined') expect(answer.reason).toContain('503');
  });

  it('does not read a document that is not JSON as an answer', async () => {
    // The failure a static host actually produces: an SPA rewrite serves the
    // app's own HTML for an unrouted path, with a perfectly healthy 200.
    const { fetch } = answering(new Response('<!doctype html><title>Ferretry</title>', { status: 200 }));
    const answer = await readHostedRelayFallback({ directoryUrl: DIRECTORY, fetcher: fetch });
    expect(answer.kind).toBe('undetermined');
    if (answer.kind === 'undetermined') expect(answer.reason).toContain('not a document');
  });

  it('carries the switch straight through when it is off', async () => {
    const { fetch } = answering(Response.json(advertisement(null)));
    expect(await readHostedRelayFallback({ directoryUrl: DIRECTORY, fetcher: fetch })).toEqual({ kind: 'disabled' });
  });
});

describe('bundledRelayDirectory', () => {
  /** The build constant is a free identifier, so a test supplies it as a global. */
  const withConstant = <T>(value: unknown, body: () => T): T => {
    const host = globalThis as Record<string, unknown>;
    const had = '__FY_RELAY_DIRECTORY__' in host;
    const previous = host.__FY_RELAY_DIRECTORY__;
    host.__FY_RELAY_DIRECTORY__ = value;
    try {
      return body();
    } finally {
      if (had) host.__FY_RELAY_DIRECTORY__ = previous;
      else delete host.__FY_RELAY_DIRECTORY__;
    }
  };

  it('reads the origin the build baked in', () => {
    // `vite.config.ts` replaces the identifier with a literal from
    // `FY_RELAY_DIRECTORY_ORIGIN`, which the Pages workflow takes from the same
    // repository variable the relay's own deploy uses.
    expect(withConstant(DIRECTORY, bundledRelayDirectory)).toBe(DIRECTORY);
  });

  it('treats an unset or absent constant as no directory, never as a default', () => {
    // A local build, a fork, or a deploy that has not configured the variable.
    // There is no literal to fall back to, and that is the point.
    expect(withConstant('', bundledRelayDirectory)).toBeUndefined();
    // And with no define at all — every consumer outside `vite build` — the free
    // identifier must degrade rather than throw.
    expect(bundledRelayDirectory()).toBeUndefined();
  });
});

describe('what the step says', () => {
  it('starts as checking, which is neither of the answers', () => {
    expect(CHECKING_HOSTED_RELAY).toEqual({ kind: 'checking' });
  });

  it('names the order and refuses to claim it tested either carrier', () => {
    expect(CARRIER_ORDER_NOTE).toContain('nothing to choose here');
    // It says what the carriers ARE. Claiming the app 'tries' them would be a
    // claim about behaviour that does not exist yet.
    expect(CARRIER_ORDER_NOTE).not.toContain('tries');
    expect(TRANSPORT_NOT_WIRED_NOTE).toContain('neither the');
    expect(TRANSPORT_NOT_WIRED_NOTE).toContain('dials it yet');
  });

  it('discloses what the hosted relay can and cannot see, and never advertises an address', () => {
    const text = [
      ...HOSTED_RELAY_DISCLOSURE,
      HOSTED_RELAY_DISABLED_NOTE,
      HOSTED_RELAY_UNDETERMINED_NOTE,
      CARRIER_ORDER_NOTE,
      TRANSPORT_NOT_WIRED_NOTE,
    ].join(' ');
    expect(text).toContain('fingerprint');
    expect(text).toContain('could not read');
    expect(text).toContain('metered and capped');
    expect(text).toContain('switched off');
    // No relay address anywhere in the copy: the address only ever arrives at
    // runtime, and a string here would be a compiled default by another name.
    expect(text).not.toMatch(/wss?:\/\//);
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).not.toContain('workers.dev');
  });
});
