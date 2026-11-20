/**
 * Each machine's tunnel switch, as this device knows it (`docs/relay-protocol.md` §15): the read, the
 * one write, and the rule that a failed read never forgets an answer.
 */

import { describe, it } from 'bun:test';
import { TUNNEL_OFF_SENTENCE, type TunnelStatusView } from '../../../contract/index.ts';
import should from 'should';
import {
  TunnelResponseError as DaemonResponseError,
  keptTunnel,
  type TunnelControl,
  TunnelSwitchStore,
} from '../../../app/lib/tunnel-switch.ts';
import { guarantee } from '../../support/guarantee.ts';

const daemon = { daemonId: 'studio' };

const OFF: TunnelStatusView = {
  enabled: false,
  explicit: false,
  state: 'off',
  tunnelUrl: null,
  sentence: TUNNEL_OFF_SENTENCE,
};
const UP: TunnelStatusView = {
  enabled: true,
  explicit: true,
  state: 'up',
  tunnelUrl: 'https://k3x9.tunnels.example.com',
  sentence: 'Tunnel: on — https://k3x9.tunnels.example.com',
};

/** A control path that answers each request with the next scripted reply, and records what was asked. */
const scripted = (...replies: ReadonlyArray<Response | Error>) => {
  const asked: Array<{ url: string; init: RequestInit }> = [];
  const control: TunnelControl = async (_daemon, url, init) => {
    asked.push({ url, init });
    const reply = replies[asked.length - 1];
    if (reply === undefined) throw new Error('nothing scripted');
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { control, asked };
};

describe('the tunnel switch store', () => {
  it('should read the machine’s switch over the control path, and tell everyone', async () => {
    const { control, asked } = scripted(Response.json(OFF));
    const observed: TunnelStatusView[] = [];
    const store = new TunnelSwitchStore({ control, observed: (_daemon, view) => observed.push(view) });
    let notified = 0;
    const unsubscribe = store.subscribe(() => {
      notified += 1;
    });

    should(store.state(daemon.daemonId)).eql({ kind: 'unknown' });
    const state = await store.refresh(daemon);

    should(state).eql({ kind: 'known', view: OFF });
    should(store.snapshot()[daemon.daemonId]).eql(state);
    should(asked.map(request => request.url)).eql(['/v1/tunnel']);
    should(asked[0]?.init.cache).equal('no-store');
    should(observed).eql([OFF]);
    should(notified).equal(1);
    unsubscribe();
    await store.refresh(daemon).catch(() => undefined);
    should(notified).equal(1);
  });

  it('should keep the last answer through a failed control read', async () => {
    const { control } = scripted(
      Response.json(UP),
      new Response('', { status: 503 }),
      new Response('not json'),
      Response.json({ enabled: 'yes' }),
      new Error('no carrier'),
    );
    const store = new TunnelSwitchStore({ control });
    await store.refresh(daemon);
    for (let attempt = 0; attempt < 4; attempt += 1)
      should(await store.refresh(daemon)).eql({ kind: 'known', view: UP });
  });

  it('should switch the tunnel with one PUT and keep what the daemon answered', async () => {
    const { control, asked } = scripted(Response.json(UP));
    const observed: TunnelStatusView[] = [];
    const store = new TunnelSwitchStore({ control, observed: (_daemon, view) => observed.push(view) });

    const result = await store.set(daemon, true);

    should(result).eql({ kind: 'applied', view: UP });
    should(store.state(daemon.daemonId)).eql({ kind: 'known', view: UP });
    should(observed).eql([UP]);
    should(asked[0]?.init.method).equal('PUT');
    should(asked[0]?.init.body).equal('{"enabled":true}');
    should(new Headers(asked[0]?.init.headers).get('content-type')).equal('application/json');
  });

  it('should treat a 202 as held for the owner: not a rejection, the view kept, the sentences handed on', async () => {
    const { control } = scripted(Response.json({ held: ['the tunnel is turned on'], view: OFF }, { status: 202 }));
    const store = new TunnelSwitchStore({ control });

    const result = await store.set(daemon, true);

    should(result).eql({ kind: 'held', view: OFF, sentences: ['the tunnel is turned on'] });
    should(store.state(daemon.daemonId)).eql({ kind: 'known', view: OFF });
  });

  it('should reject a 202 that is not a held answer', async () => {
    const { control } = scripted(Response.json({ nothing: true }, { status: 202 }));
    const store = new TunnelSwitchStore({ control });

    const refused = await store.set(daemon, true).catch((reason: unknown) => reason);

    should(refused).be.instanceOf(DaemonResponseError);
    should((refused as DaemonResponseError).status).equal(502);
  });

  it('should reject with the daemon’s own sentence and code, and change nothing', async () => {
    const store = new TunnelSwitchStore(
      scripted(
        Response.json(
          { error: 'pairing configure is off for this device', code: 'grant_not_granted' },
          { status: 403 },
        ),
        new Response('', { status: 500 }),
        Response.json({ nope: true }),
      ),
    );

    const refused = await store.set(daemon, true).catch((reason: unknown) => reason);
    should(refused).be.instanceOf(DaemonResponseError);
    should((refused as DaemonResponseError).status).equal(403);
    should((refused as DaemonResponseError).message).equal('pairing configure is off for this device');
    should((refused as DaemonResponseError).code).equal('grant_not_granted');

    const bare = await store.set(daemon, true).catch((reason: unknown) => reason);
    should((bare as DaemonResponseError).message).equal('HTTP 500');
    should((bare as DaemonResponseError).code).be.undefined();

    const garbled = await store.set(daemon, false).catch((reason: unknown) => reason);
    should((garbled as DaemonResponseError).status).equal(502);
    should(store.state(daemon.daemonId)).eql({ kind: 'unknown' });
  });
});

describe('what an answer means for the tunnel this device keeps', () => {
  guarantee(
    ['R635'],
    'should keep a tunnel that is up, forget one that is off or cannot run, and leave one that is coming',
    () => {
      should(keptTunnel(UP)).eql({ kind: 'tunnel', tunnelUrl: 'https://k3x9.tunnels.example.com' });
      should(keptTunnel(OFF)).be.null();
      should(keptTunnel({ ...UP, state: 'unavailable', tunnelUrl: null })).be.null();
      should(keptTunnel({ ...UP, state: 'provisioning', tunnelUrl: null })).be.undefined();
      should(keptTunnel({ ...UP, state: 'connecting' })).be.undefined();
      should(keptTunnel({ ...UP, tunnelUrl: null })).be.undefined();
      // An address this browser would refuse to dial is not kept.
      should(keptTunnel({ ...UP, tunnelUrl: 'http://plaintext.example.com' })).be.undefined();
    },
  );
});
