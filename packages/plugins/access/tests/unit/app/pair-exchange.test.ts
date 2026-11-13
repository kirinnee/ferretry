import { describe, it } from 'bun:test';
import { type PairDirectInput, type PairedDaemon, type PairedOver, RelayPairingRefusedError } from '@ferretry/app';
import should from 'should';
import { accessClaims } from '../../../app/connect.ts';
import { exchangePairing, type PairingPorts } from '../../../app/lib/pair-exchange.ts';
import type { PairingSeed } from '../../../app/lib/pairing.ts';
import { MemoryDeviceKeyStore, testDeviceKeyCrypto, type TestKeyHandle } from '../../support/app/device-keys.ts';

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

/** What the shell does on a sealed `paired` answer (P28): hand Access the response to validate and persist. */
const sealedPaired = async (input: PairDirectInput, answer: unknown) => {
  await input.key.save(answer as never);
  return answer;
};

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
        should(store.pending.has(daemonId)).be.false();
        return {
          kind: 'paired',
          response: await sealedPaired(input, response()),
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
        // The pairing crossed a relay, so nothing marks the link's address as one this device paired over.
        carriers: response().carriers,
      },
    ]);
    should(result.daemon).equal(daemonId);
  });

  it('falls back to a direct pairing over the pairing’s own address when the shell offers no walk', async () => {
    const { store, claims, added, inputs, base } = harness();
    const ports: PairingPorts = {
      ...base,
      pairDirect: async input => {
        inputs.push(input);
        return { kind: 'paired', response: await sealedPaired(input, response()) } as never;
      },
    };

    await exchangePairing({ ports, claims, store }, seed, 'My phone');
    // A direct pairing records the address it crossed AND the positive mark that it paired over it.
    should(added[0]).have.property('pairedOver', 'direct');

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
      pairDirect: async input =>
        ({
          kind: 'paired',
          response: await sealedPaired(input, response({ daemonId: `fy_daemon_${'z'.repeat(43)}` })),
        }) as never,
    };

    await exchangePairing({ ports, claims, store }, seed, 'My phone').should.be.rejectedWith(
      /does not match the daemon this key was minted for/u,
    );

    should(store.keys.has(daemonId)).be.false();
    should(added).be.empty();
  });

  it('keeps nothing when the answer is not a pairing response', async () => {
    const { store, claims, added, base } = harness();
    const ports: PairingPorts = {
      ...base,
      pairDirect: async input => ({ kind: 'paired', response: await sealedPaired(input, { nope: true }) }) as never,
    };

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
      pair: async input =>
        ({
          kind: 'paired',
          response: await sealedPaired(input, response()),
          via: { kind: 'relay', address: 'wss://other-relay.example.test' },
        }) as PairedOver,
    };

    await exchangePairing({ ports, claims, store }, seed, 'My phone').should.be.rejectedWith(/does not publish/u);

    should(store.keys.has(daemonId)).be.false();
    should(added).be.empty();
  });

  it('keeps nothing when a relayed pairing crossed a rendezvous that cannot be dialled', async () => {
    const { store, claims, added, base } = harness();
    const ports: PairingPorts = {
      ...base,
      pairDirect: async () => {
        throw new Error('unused');
      },
      pair: async input =>
        ({
          kind: 'paired',
          response: await sealedPaired(input, response()),
          via: { kind: 'relay', address: 'not a relay address' },
        }) as PairedOver,
    };

    await exchangePairing({ ports, claims, store }, seed, 'My phone').should.be.rejectedWith(
      /crossed a rendezvous that is not dialable/u,
    );

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
      pairDirect: async input => ({ kind: 'paired', response: await sealedPaired(input, response()) }) as never,
    };

    await exchangePairing({ ports, claims, store }, seed, 'My phone').should.be.rejectedWith(/list full/u);

    should(store.keys.has(daemonId)).be.false();
  });

  describe('re-pairing a daemon this device already holds a key for', () => {
    const withOldKey = async () => {
      const h = harness();
      const { privateKey } = await testDeviceKeyCrypto.generateDeviceKey();
      await h.store.save(daemonId, privateKey);
      return { ...h, old: privateKey };
    };

    it('P28 keeps the old working key when the code is refused, and writes nothing', async () => {
      const { store, claims, base, old } = await withOldKey();
      const saves = store.saved.length;
      const ports: PairingPorts = {
        ...base,
        pairDirect: async () => {
          throw new RelayPairingRefusedError();
        },
      };

      await exchangePairing({ ports, claims, store }, seed, 'My phone').should.be.rejectedWith(
        RelayPairingRefusedError,
      );

      should(store.keys.get(daemonId)).equal(old);
      should(store.saved).have.length(saves);
    });

    it('P28 replaces the old key only once the sealed answer was saved, and claim() then finds the new one', async () => {
      const { store, claims, base, old } = await withOldKey();
      let during: CryptoKey | undefined;
      const ports: PairingPorts = {
        ...base,
        pairDirect: async input => {
          during = store.keys.get(daemonId);
          return { kind: 'paired', response: await sealedPaired(input, response()) } as never;
        },
      };

      await exchangePairing({ ports, claims, store }, seed, 'My phone');

      should(during).equal(old);
      const now = store.keys.get(daemonId);
      should(now).not.equal(old);
      const claim = await claims.claim({ daemon: daemonId, deviceId } as PairedDaemon);
      should((claim as unknown as { key: TestKeyHandle }).key.key).equal(now);
      should(store.pending.has(daemonId)).be.false();
    });

    it('puts the old key back when the exchange refuses the pairing after the key was saved', async () => {
      const { store, claims, added, base, old } = await withOldKey();
      const ports: PairingPorts = {
        ...base,
        pairDirect: async () => {
          throw new Error('unused');
        },
        pair: async input =>
          ({
            kind: 'paired',
            response: await sealedPaired(input, response()),
            via: { kind: 'relay', address: 'wss://other-relay.example.test' },
          }) as PairedOver,
      };

      await exchangePairing({ ports, claims, store }, seed, 'My phone').should.be.rejectedWith(/does not publish/u);

      should(store.keys.get(daemonId)).equal(old);
      should(added).be.empty();
    });
  });
});
