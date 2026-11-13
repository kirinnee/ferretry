/**
 * Whose relay is the live carrier, as the Connection card says it (rehearsal 3, F1).
 *
 * Only POSITIVE evidence picks an ownership-specific wording: the address the browser DISCOVERED is Ferretry's hosted
 * relay, and a relay the daemon lists as configured is only that — configured. Every other relay — the directory timed out,
 * is switched off, names another address, or the daemon says nothing — reads as a neutral unknown-operator "Relay".
 * Directory availability is not proof of ownership.
 * The decision must hold when the first session is asked for before the directory answered (a reload: the stored
 * pairing walks at once and the advertisement read is still in flight), because a carrier stamped as someone's own relay in
 * that window told the owner a security disclosure that is false for the hosted default. So the walk waits for that one
 * read before it dials a published relay — and for nothing else.
 */
import { describe, expect, test } from 'bun:test';
import { describeConnectionMethod } from '../../../app/lib/connection.ts';
import { carriedOver, rig } from '../../support/router-rig.ts';

const RELAY = 'wss://relay.example';
const RELAY_HOST = 'relay.example';
const HOSTS = { [RELAY_HOST]: { kind: 'carries', carrier: 'relay' } } as const;
const PUBLISHED = [{ kind: 'relay', url: RELAY }] as const;

const pause = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

describe('the live relay is labelled by who runs it', () => {
  test('a discovered hosted relay reads "Hosted relay" when the directory answered first', async () => {
    const r = await rig(HOSTS, PUBLISHED, 'auto', RELAY);
    const transport = await r.connect();
    if (transport === undefined) throw new Error('no transport');

    await transport.request({ method: 'GET', path: '/v1/example' });

    const choice = r.router.choice(r.fx.daemonId);
    if (choice?.ok !== true) throw new Error('nothing carried');
    expect(describeConnectionMethod(choice.method).label).toBe('Hosted relay');
    r.fx.layer.close();
  });

  test('a discovered hosted relay reads "Hosted relay" even when the first session is asked for before the directory answered', async () => {
    let release: (url: string | undefined) => void = () => undefined;
    const r = await rig(HOSTS, PUBLISHED, 'auto', null, undefined, {
      hostedRelay: () =>
        new Promise<string | undefined>(resolve => {
          release = resolve;
        }),
    });
    const transport = await r.connect();
    if (transport === undefined) throw new Error('no transport');
    // The session is asked for while the advertisement read is still in flight (a reload walking a stored pairing).
    const answered = transport.request({ method: 'GET', path: '/v1/example' });
    await pause();
    expect(r.network.dialled).toEqual([]);
    release(RELAY);
    await answered;

    expect(carriedOver(r.fx)).toEqual(['/v1/example relay']);
    const choice = r.router.choice(r.fx.daemonId);
    if (choice?.ok !== true) throw new Error('nothing carried');
    expect(describeConnectionMethod(choice.method).label).toBe('Hosted relay');
    r.fx.layer.close();
  });

  /** What the card says for the live relay once a session has been carried over it. */
  async function labelFor(
    published: readonly unknown[],
    hosted: string | null,
    extra: Parameters<typeof rig>[5] = {},
  ): Promise<ReturnType<typeof describeConnectionMethod>> {
    const r = await rig(HOSTS, published, 'auto', hosted, undefined, extra);
    const transport = await r.connect();
    if (transport === undefined) throw new Error('no transport');
    await transport.request({ method: 'GET', path: '/v1/example' });
    const choice = r.router.choice(r.fx.daemonId);
    if (choice?.ok !== true) throw new Error('nothing carried');
    r.fx.layer.close();
    return describeConnectionMethod(choice.method);
  }

  const claimsNoOwner = (words: string): void => {
    expect(words).not.toMatch(/your own|you are the relay operator|nobody outside your account/iu);
  };

  test('a relay the directory named differently, with no ownership claim, reads as an unknown-operator "Relay"', async () => {
    const shown = await labelFor(PUBLISHED, 'wss://hosted.example');
    expect(shown.label).toBe('Relay');
    expect(shown.noun).toBe('a relay');
    claimsNoOwner([shown.label, shown.noun, shown.summary, ...shown.observers].join(' '));
  });

  test('a relay reads as an unknown-operator "Relay" when the directory has no relay to name (disabled or absent)', async () => {
    const shown = await labelFor(PUBLISHED, null);
    expect(shown.label).toBe('Relay');
    claimsNoOwner([shown.summary, ...shown.observers].join(' '));
  });

  test('a relay reads as an unknown-operator "Relay" when the directory read times out or fails', async () => {
    const shown = await labelFor(PUBLISHED, null, {
      hostedRelay: () => Promise.reject(new Error('the directory did not answer in time')),
    });
    expect(shown.label).toBe('Relay');
    claimsNoOwner([shown.summary, ...shown.observers].join(' '));
  });

  test('the hosted relay stays "Hosted relay" however the daemon marked it', async () => {
    const shown = await labelFor([{ kind: 'relay', url: RELAY, source: 'configured' }], RELAY);
    expect(shown.label).toBe('Hosted relay');
  });

  const CONFIGURED_PUBLISHED = [{ kind: 'relay', url: RELAY, source: 'configured' }];

  test('a configured relay that is NOT the discovered hosted one reads "Configured relay", whatever the directory said', async () => {
    for (const hosted of [null, 'wss://hosted.example']) {
      const shown = await labelFor(CONFIGURED_PUBLISHED, hosted);
      expect(shown.label).toBe('Configured relay');
      expect(shown.noun).toBe('the relay this machine is set up to use');
    }
    const timedOut = await labelFor(CONFIGURED_PUBLISHED, null, {
      hostedRelay: () => Promise.reject(new Error('timed out')),
    });
    expect(timedOut.label).toBe('Configured relay');
  });

  test('Ferretry’s hosted URL entered by hand while the directory is down reads "Configured relay" and claims no ownership', async () => {
    // The owner wrote the hosted address into the carriers list; the directory read failed or named nothing. The app
    // cannot know whose relay this is, and an entered address proves only that it was entered.
    for (const extra of [
      { hostedRelay: () => Promise.reject(new Error('the directory did not answer in time')) },
      { hostedRelay: () => Promise.resolve(undefined) },
    ]) {
      const shown = await labelFor(CONFIGURED_PUBLISHED, null, extra);
      expect(shown.label).toBe('Configured relay');
      expect(shown.label).not.toBe('Hosted relay');
      // Everything except the one explicitly conditional sentence is free of an ownership claim.
      claimsNoOwner([shown.summary, shown.noun, ...shown.observers.slice(0, -1)].join(' '));
      expect(shown.observers.at(-1)).toBe(
        'If you run this relay yourself, only you and your hosting provider are on the path.',
      );
    }
  });
});
