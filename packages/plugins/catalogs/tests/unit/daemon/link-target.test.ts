import { describe, expect, it } from 'bun:test';
import { shareLinkTarget } from '../../../daemon/lib/catalog-members/link-target.ts';

const ORIGIN = 'https://app.example.test';
const DAEMON = 'fy_daemon_x';
const RELAY = 'https://relay.example.test';

describe('shareLinkTarget', () => {
  it('asks the person to wait while the machine is still starting', () => {
    expect(shareLinkTarget(undefined, DAEMON, ORIGIN, undefined)).toEqual({
      kind: 'unavailable',
      reason: 'This machine is still starting. Try again in a moment.',
    });
    expect(shareLinkTarget({ kind: 'none', refusal: 'no-port' }, undefined, ORIGIN, undefined).kind).toBe(
      'unavailable',
    );
  });

  it('points a link at an address another device can dial, as it is', () => {
    expect(
      shareLinkTarget(
        { kind: 'address', url: 'https://studio.example.net', origin: 'operator' },
        DAEMON,
        ORIGIN,
        undefined,
      ),
    ).toEqual({ kind: 'ready', appOrigin: ORIGIN, daemonUrl: 'https://studio.example.net', daemonId: DAEMON });
  });

  it('keeps a loopback address when a discoverable rendezvous carries it', () => {
    expect(shareLinkTarget({ kind: 'local-only', url: 'http://127.0.0.1:7777' }, DAEMON, ORIGIN, RELAY)).toEqual({
      kind: 'ready',
      appOrigin: ORIGIN,
      daemonUrl: 'http://127.0.0.1:7777',
      daemonId: DAEMON,
    });
  });

  it('judges a loopback public address as a loopback bind, so it is refused without a rendezvous', () => {
    const target = shareLinkTarget(
      { kind: 'address', url: 'http://127.0.0.1:7777', origin: 'operator' },
      DAEMON,
      ORIGIN,
      undefined,
    );
    expect(target.kind).toBe('unavailable');
  });

  it('refuses a loopback-only machine with no relay another browser can find, naming the remedy', () => {
    const target = shareLinkTarget({ kind: 'local-only', url: 'http://127.0.0.1:7777' }, DAEMON, ORIGIN, undefined);
    expect(target.kind).toBe('unavailable');
    expect(target.kind === 'unavailable' && target.reason).toContain('hosted relay');
  });

  it('says a machine with no port has nothing to put in a link', () => {
    const target = shareLinkTarget({ kind: 'none', refusal: 'no-port' }, DAEMON, ORIGIN, RELAY);
    expect(target.kind === 'unavailable' && target.reason).toContain('no port');
  });

  it('says a wildcard bind with no public address has nowhere to point', () => {
    const target = shareLinkTarget({ kind: 'none', refusal: 'wildcard-bind' }, DAEMON, ORIGIN, RELAY);
    expect(target.kind === 'unavailable' && target.reason).toContain('public address');
  });
});
