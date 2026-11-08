import { describe, expect, test } from 'bun:test';
import * as barrel from '../../../src/index.ts';
import {
  DIRECT_MEMBER_DEADLINE_MS,
  memberTunnelRequest,
  memberTunnelResponse,
  memberWalk,
  RELAY_MEMBER_DEADLINE_MS,
} from '../../../src/connect/member.ts';

const ID = `fy_daemon_${'a'.repeat(43)}`;
const OWN = 'https://box.example.test';
const HOSTED = 'wss://relay.example.test';
const publisher = (extra: object = {}) => ({ daemonId: ID, daemonUrl: OWN, ...extra });
const addresses = (steps: readonly { address: string }[]) => steps.map(step => step.address);

describe('S3 only the shell composition installs member carriers', () => {
  test('the app barrel exports no setter, so no half can install carriers', () => {
    expect('setMemberCarriers' in barrel).toBe(false);
    expect(typeof barrel.memberCarriers).toBe('function');
    expect(typeof barrel.memberWalk).toBe('function');
  });
});

describe('S4 the member walk is a pure function the carrier cannot replace', () => {
  test('a join walks the publisher then the one discovered rendezvous, with caller-set deadlines', () => {
    const steps = memberWalk(publisher(), 'join', { rendezvousUrl: HOSTED, servedFromLoopback: false });
    expect(steps).toEqual([
      { kind: 'direct', address: OWN, deadlineMs: DIRECT_MEMBER_DEADLINE_MS },
      { kind: 'relay', address: HOSTED, deadlineMs: RELAY_MEMBER_DEADLINE_MS },
    ]);
    expect(RELAY_MEMBER_DEADLINE_MS).toBe(45_000);
  });

  test('a fingerprint that is not a daemon id gets no step at all, not even the direct one', () => {
    expect(memberWalk({ daemonId: 'nope', daemonUrl: OWN }, 'join', { rendezvousUrl: HOSTED })).toEqual([]);
    expect(memberWalk({ daemonId: 'nope', daemonUrl: OWN }, 'member', { rendezvousUrl: HOSTED })).toEqual([]);
  });

  test('a loopback publisher address is not dialled beside a rendezvous from a hosted page, and goes last from a local one', () => {
    const local = publisher({ daemonUrl: 'http://127.0.0.1:7777' });
    expect(addresses(memberWalk(local, 'join', { rendezvousUrl: HOSTED, servedFromLoopback: false }))).toEqual([
      HOSTED,
    ]);
    expect(addresses(memberWalk(local, 'join', { rendezvousUrl: HOSTED, servedFromLoopback: true }))).toEqual([
      HOSTED,
      'http://127.0.0.1:7777',
    ]);
    expect(addresses(memberWalk(local, 'join', { servedFromLoopback: false }))).toEqual(['http://127.0.0.1:7777']);
  });

  test('a member walk takes the published relays, drops tunnels and undialable entries, and de-duplicates the rendezvous', () => {
    const steps = memberWalk(
      publisher({
        carriers: [
          { kind: 'tunnel', url: 'https://t.example.test' },
          { kind: 'relay', url: 'ws://relay.elsewhere.test' },
          { kind: 'relay', url: 'wss://own-relay.example.test' },
          { kind: 'relay', url: HOSTED },
          { kind: 'direct', url: OWN },
          { kind: 'direct', url: 'https://alt.example.test' },
        ],
      }),
      'member',
      { rendezvousUrl: HOSTED, servedFromLoopback: false },
    );
    expect(addresses(steps)).toEqual([OWN, 'https://alt.example.test', 'wss://own-relay.example.test', HOSTED]);
  });

  test('an undialable discovered rendezvous is not walked', () => {
    expect(addresses(memberWalk(publisher(), 'join', { rendezvousUrl: 'ws://relay.example.test' }))).toEqual([OWN]);
  });
});

describe('S4 the tunnel record is fixed in the app', () => {
  test('a request becomes the record, dropping authorization and refusing a body that is not text', () => {
    expect(
      memberTunnelRequest(`${OWN}/v1/shared/me?x=1`, {
        method: 'post',
        headers: { authorization: 'Bearer x', 'content-type': 'application/json' },
        body: '{}',
      }),
    ).toEqual({
      method: 'POST',
      path: '/v1/shared/me',
      query: [['x', '1']],
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(() => memberTunnelRequest(`${OWN}/v1/x`, { method: 'POST', body: new Uint8Array([1]) })).toThrow();
  });

  test('an answer becomes a Response, bodyless statuses without a body', async () => {
    const ok = memberTunnelResponse({ kind: 'response', status: 200, headers: {}, body: '{"a":1}' });
    expect(await ok.json()).toEqual({ a: 1 });
    expect(memberTunnelResponse({ kind: 'response', status: 204, headers: {}, body: '' }).status).toBe(204);
  });
});
