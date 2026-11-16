import { describe, expect, test } from 'bun:test';
import { HOSTED_APP_ORIGIN } from '@ferretry/kernel/contract';
import { LiveWindowLedger } from '@ferretry/std/live-window';
import { protectionWindows } from '../../daemon/protection/windows.ts';

/**
 * THE DAEMON'S OWN FACTS, as the guard reads them (docs/pairing.md, "Never show it to an agent"): which origins are the
 * app's, from what Connections advertises, and whether any credential was live, from every provider.
 */
const advertised = (
  url: string | undefined,
  allowed: readonly string[] = [],
  app = 'https://app.example.test',
  port?: number,
) => ({
  advertisement: () =>
    ({
      advertisement: url === undefined ? { kind: 'none', refusal: {} } : { kind: 'address', url, origin: 'operator' },
      appOrigin: app,
      allowedOrigins: allowed,
      ...(port === undefined ? {} : { port }),
    }) as never,
});

describe('the origins that are the app', () => {
  test('it is the hosted app, the advertised app origin, the allowed browser origins and the advertised listener', () => {
    const windows = protectionWindows({
      now: () => 1,
      connections: () => advertised('http://127.0.0.1:7077/', ['https://pwa.example.test']),
      windows: [],
    });

    expect([...(windows.appOrigins() ?? [])].sort()).toEqual(
      [
        HOSTED_APP_ORIGIN,
        'https://app.example.test',
        'https://pwa.example.test',
        'http://127.0.0.1:7077',
        'http://localhost:7077',
        'http://[::1]:7077',
      ].sort(),
    );
  });

  test('it is not one hard-coded address: a different advertisement is a different set', () => {
    const windows = protectionWindows({
      now: () => 1,
      connections: () => advertised(undefined, [], 'https://other.example.test'),
      windows: [],
    });

    expect(windows.appOrigins()?.has('https://other.example.test')).toBe(true);
    expect(windows.appOrigins()?.has('https://app.example.test')).toBe(false);
  });

  test('it is unknown (undefined: every page is the app) when Connections is absent, throws, or says something unreadable', () => {
    const absent = protectionWindows({ now: () => 1, connections: () => undefined, windows: [] });
    const throwing = protectionWindows({
      now: () => 1,
      connections: () => ({
        advertisement: () => {
          throw new Error('unavailable');
        },
      }),
      windows: [],
    });
    const unreadable = protectionWindows({
      now: () => 1,
      connections: () => advertised(undefined, ['not an origin']),
      windows: [],
    });

    expect(absent.appOrigins()).toBeUndefined();
    expect(throwing.appOrigins()).toBeUndefined();
    expect(unreadable.appOrigins()).toBeUndefined();
  });
});

describe('when a credential was live', () => {
  const ledger = (open: boolean) => {
    const clock = { at: 1_000 };
    const window = new LiveWindowLedger(() => clock.at);
    if (open) {
      window.open('a', 5_000);
      clock.at = 2_000;
      window.close('a');
    }
    return window;
  };

  test('it is no only when EVERY provider says no', () => {
    const none = protectionWindows({
      now: () => 1,
      connections: () => undefined,
      windows: [() => ledger(false), () => ledger(false)],
    });
    const one = protectionWindows({
      now: () => 1,
      connections: () => undefined,
      windows: [() => ledger(false), () => ledger(true)],
    });

    expect(none.liveSince(0)).toBe(false);
    expect(one.liveSince(0)).toBe(true);
  });

  test('a provider that is absent or throws is live: unknown is live', () => {
    const absent = protectionWindows({
      now: () => 1,
      connections: () => undefined,
      windows: [() => ledger(false), () => undefined],
    });
    const throwing = protectionWindows({
      now: () => 1,
      connections: () => undefined,
      windows: [
        () => ({
          live: () => false,
          liveSince: () => {
            throw new Error('boom');
          },
        }),
      ],
    });
    const odd = protectionWindows({
      now: () => 1,
      connections: () => undefined,
      windows: [() => ({ live: () => false, liveSince: () => undefined as never })],
    });

    expect(absent.liveSince(0)).toBe(true);
    expect(throwing.liveSince(0)).toBe(true);
    expect(odd.liveSince(0)).toBe(true);
  });
});

describe('the daemon’s own loopback app, whatever it is bound to', () => {
  const LOOPBACKS = (port: number): string[] => [
    `http://127.0.0.1:${String(port)}`,
    `http://localhost:${String(port)}`,
    `http://[::1]:${String(port)}`,
  ];
  const originsOf = (connections: ReturnType<typeof advertised>) =>
    protectionWindows({ now: () => 1, connections: () => connections, windows: [] }).appOrigins();

  test('a daemon bound to 0.0.0.0 with an operator public address is the app on every spelling of loopback at its port', () => {
    const origins = originsOf(
      advertised(
        'https://fy.lan.example.test/',
        ['http://0.0.0.0:7077', 'https://fy.lan.example.test'],
        undefined,
        7077,
      ),
    );

    for (const origin of LOOPBACKS(7077)) expect(origins?.has(origin)).toBe(true);
    expect(origins?.has('https://fy.lan.example.test')).toBe(true);
  });

  test('a wildcard bind with nothing to advertise is still the app on loopback (the listener port is the fact)', () => {
    const origins = originsOf(advertised(undefined, [], undefined, 7077));

    for (const origin of LOOPBACKS(7077)) expect(origins?.has(origin)).toBe(true);
  });

  test('an IPv6 wildcard, as an allowed origin, is the app on every spelling of loopback at that port', () => {
    const origins = originsOf(advertised(undefined, ['http://[::]:8123'], undefined));

    for (const origin of LOOPBACKS(8123)) expect(origins?.has(origin)).toBe(true);
  });

  test('a configured loopback origin is the app on every spelling of loopback at ITS port', () => {
    const origins = originsOf(advertised('http://127.0.0.1:7077/', ['http://localhost:7077']));

    for (const origin of LOOPBACKS(7077)) expect(origins?.has(origin)).toBe(true);
  });

  test('an unrelated port on loopback is NOT the app, and neither is an unrelated host', () => {
    const origins = originsOf(advertised('https://fy.lan.example.test/', ['http://0.0.0.0:7077'], undefined, 7077));

    for (const origin of LOOPBACKS(7078)) expect(origins?.has(origin)).toBe(false);
    expect(origins?.has('http://127.0.0.1')).toBe(false);
    expect(origins?.has('https://other.example.test')).toBe(false);
  });

  test('the hosted app is always there, whatever else is configured', () => {
    const origins = originsOf(advertised(undefined, ['https://only.example.test'], 'https://only.example.test', 7077));

    expect(origins?.has(HOSTED_APP_ORIGIN)).toBe(true);
  });
});
