import { describe, expect, test } from 'bun:test';
import { HOSTED_APP_ORIGIN } from '@ferretry/kernel/contract';
import { LiveWindowLedger } from '@ferretry/std/live-window';
import { protectionWindows } from '../../daemon/protection/windows.ts';

/**
 * THE DAEMON'S OWN FACTS, as the guard reads them (docs/pairing.md, "Never show it to an agent"): which origins are the
 * app's, from what Connections advertises, and whether any credential was live, from every provider.
 */
const advertised = (url: string | undefined, allowed: readonly string[] = [], app = 'https://app.example.test') => ({
  advertisement: () =>
    ({
      advertisement: url === undefined ? { kind: 'none', refusal: {} } : { kind: 'address', url, origin: 'operator' },
      appOrigin: app,
      allowedOrigins: allowed,
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
      [HOSTED_APP_ORIGIN, 'https://app.example.test', 'https://pwa.example.test', 'http://127.0.0.1:7077'].sort(),
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
