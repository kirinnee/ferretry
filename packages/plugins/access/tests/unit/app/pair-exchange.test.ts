import { describe, it } from 'bun:test';
import { type PairDirectInput, type PairedDaemon, type PairedOver, RelayPairingRefusedError } from '@ferretry/app';
import should from 'should';
import { accessClaims } from '../../../app/connect.ts';
import { exchangePairing, type PairingPorts } from '../../../app/lib/pair-exchange.ts';
import type { PairingSeed } from '../../../app/lib/pairing.ts';
import { MemoryDeviceKeyStore, testDeviceKeyCrypto } from '../../support/app/device-keys.ts';

const daemonId = `fy_daemon_${'a'.repeat(43)}`;
const deviceId = `fy_device_id_${'b'.repeat(22)}`;
const seed: PairingSeed = { daemonUrl: 'https://daemon.example.test', daemonId, code: '7F3K-Q2ND' };

const response = (over: Record<string, unknown> = {}) => ({
  deviceId,
  idleExpiryDays: 30,
  daemonId,
  daemonName: 'workstation',
  capabilities: ['daemon-api'],
  carriers: [
    { kind: 'direct', url: 'https://daemon.example.test' },
    { kind: 'relay', url: 'wss://relay.example.test' },
  ],
  ...over,
});

const harness = () => {
  const store = new MemoryDeviceKeyStore();
  const claims = accessClaims(
    { crypto: testDeviceKeyCrypto as never, indexedDB: null },
    { store, appSession: 'page-load-1', deviceName: () => 'default name' },
  );
  const added: unknown[] = [];
  const inputs: PairDirectInput[] = [];
  const calls: string[] = [];
  const base = {
    daemons: {
      add: (input: unknown) => {
        added.push(input);
        return { ...(input as object), pairedAt: 1, lastSelectedAt: 1 } as PairedDaemon;
      },
    } as never,
  };
  return { store, claims, added, inputs, calls, base };
};

describe('the pairing exchange', () => {
  it('R582 pairs through the shell’s walk when it has one, under the name the person gave, and keeps the key only after the answer', async () => {
    const { store, claims, added, inputs, calls, base } = harness();
    const ports: PairingPorts = {
      ...base,
      pairDirect: async () => {
        calls.push('pairDirect');
        throw new Error('the walk was not used');
      },
      pair: async input => {
        calls.push('pair');
        inputs.push(input);
        should(store.keys.has(daemonId)).be.false();
        should(store.pending.has(daemonId)).be.true();
        return {
          kind: 'paired',
          response: response(),
          via: { kind: 'relay', address: 'wss://relay.example.test' },
        } as PairedOver;
      },
    };

    const result = await exchangePairing({ ports, claims, store }, seed, 'My phone');

    should(calls).eql(['pair']);
    should(inputs[0]?.key.deviceName).equal('My phone');
    should(inputs[0]).containEql({ address: seed.daemonUrl, daemonId, code: seed.code });
    should(store.keys.has(daemonId)).be.true();
    should(store.pending.has(daemonId)).be.false();
    should(added).eql([
      {
        daemon: daemonId,
        machine: 'workstation',
        deviceId,
        address: 'https://daemon.example.test',
        carriers: response().carriers,
      },
    ]);
    should(result.daemon).equal(daemonId);
  });

  it('falls back to a direct pairing over the pairing’s own address when the shell offers no walk', async () => {
    const { store, claims, inputs, base } = harness();
    const ports: PairingPorts = {
      ...base,
      pairDirect: async input => {
        inputs.push(input);
        return { kind: 'paired', response: response() };
      },
    };

    await exchangePairing({ ports, claims, store }, seed, 'My phone');

    should(inputs).have.length(1);
    should(inputs[0]?.address).equal(seed.daemonUrl);
    should(store.keys.has(daemonId)).be.true();
  });

  it('keeps nothing when the daemon refuses the code, and lets the refusal through as itself', async () => {
    const { store, claims, added, base } = harness();
    const ports: PairingPorts = {
      ...base,
      pairDirect: async () => {
        throw new RelayPairingRefusedError();
      },
    };

    await exchangePairing({ ports, claims, store }, seed, 'My phone').should.be.rejectedWith(RelayPairingRefusedError);

    should(store.keys.has(daemonId)).be.false();
    should(store.pending.has(daemonId)).be.false();
    should(added).be.empty();
  });

  it('keeps nothing when the answer names another daemon than the link pinned', async () => {
    const { store, claims, added, base } = harness();
    const ports: PairingPorts = {
      ...base,
      pairDirect: async () => ({ kind: 'paired', response: response({ daemonId: `fy_daemon_${'z'.repeat(43)}` }) }),
    };

    await exchangePairing({ ports, claims, store }, seed, 'My phone').should.be.rejectedWith(
      /does not match its fingerprint/u,
    );

    should(store.keys.has(daemonId)).be.false();
    should(added).be.empty();
  });

  it('keeps nothing when the answer is not a pairing response', async () => {
    const { store, claims, added, base } = harness();
    const ports: PairingPorts = { ...base, pairDirect: async () => ({ kind: 'paired', response: { nope: true } }) };

    await exchangePairing({ ports, claims, store }, seed, 'My phone').should.be.rejected();

    should(store.keys.has(daemonId)).be.false();
    should(added).be.empty();
  });

  it('refuses a relayed pairing (§14) whose published set does not name the rendezvous it crossed', async () => {
    const { store, claims, added, base } = harness();
    const ports: PairingPorts = {
      ...base,
      pairDirect: async () => {
        throw new Error('unused');
      },
      pair: async () =>
        ({
          kind: 'paired',
          response: response(),
          via: { kind: 'relay', address: 'wss://other-relay.example.test' },
        }) as PairedOver,
    };

    await exchangePairing({ ports, claims, store }, seed, 'My phone').should.be.rejectedWith(/does not publish/u);

    should(store.keys.has(daemonId)).be.false();
    should(added).be.empty();
  });

  it('forgets the key again when the daemon list refuses the pairing', async () => {
    const { store, claims } = harness();
    const ports: PairingPorts = {
      daemons: {
        add: () => {
          throw new Error('list full');
        },
      } as never,
      pairDirect: async () => ({ kind: 'paired', response: response() }),
    };

    await exchangePairing({ ports, claims, store }, seed, 'My phone').should.be.rejectedWith(/list full/u);

    should(store.keys.has(daemonId)).be.false();
  });
});
