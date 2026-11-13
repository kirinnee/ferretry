/**
 * Whose relay is the live carrier, as the Connection card says it (rehearsal 3, F1).
 *
 * The wire names no operator — a daemon's self-report is not something a device can check — so the browser decides:
 * the published relay that is the address it DISCOVERED is Ferretry's hosted relay, and any other is the owner's own.
 * The decision must hold when the first session is asked for before the directory answered (a reload: the stored
 * pairing walks at once and the advertisement read is still in flight), because a carrier stamped "your own relay" in
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

  test('a relay the directory did not name reads "Your own relay"', async () => {
    const r = await rig(HOSTS, PUBLISHED, 'auto', 'wss://hosted.example');
    const transport = await r.connect();
    if (transport === undefined) throw new Error('no transport');

    await transport.request({ method: 'GET', path: '/v1/example' });

    const choice = r.router.choice(r.fx.daemonId);
    if (choice?.ok !== true) throw new Error('nothing carried');
    expect(describeConnectionMethod(choice.method).label).toBe('Your own relay');
    r.fx.layer.close();
  });

  test('a relay stays "Your own relay" when the directory never names one', async () => {
    const r = await rig(HOSTS, PUBLISHED, 'auto', null);
    const transport = await r.connect();
    if (transport === undefined) throw new Error('no transport');

    await transport.request({ method: 'GET', path: '/v1/example' });

    const choice = r.router.choice(r.fx.daemonId);
    if (choice?.ok !== true) throw new Error('nothing carried');
    expect(describeConnectionMethod(choice.method).label).toBe('Your own relay');
    r.fx.layer.close();
  });
});
