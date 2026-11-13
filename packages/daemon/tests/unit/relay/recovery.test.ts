/**
 * A RECOVERED RELAY LOOKUP MUST NOT OUTLIVE THE DECISIONS THAT HAPPENED WHILE IT WAS FAILING.
 *
 * The directory can answer minutes after the boot asked. In between the operator may have written a
 * `relay` block (an explicit entry always wins — `enabled: false` included) or the daemon may have begun
 * to stop; a late success that started the hosted carrier anyway turns an emergency stop into a
 * suggestion, or starts a socket on a daemon whose storage is closing. Every case below holds one of
 * those orderings still, by deferring the read or the factory, and asserts nothing starts or publishes.
 */

import { describe, it } from 'bun:test';
import should from 'should';
import {
  type RecoverableCarrier,
  type RecoveredCarrier,
  type RelayAdvertisement,
  type RelayCarrierSource,
  type RelayRecoveryPorts,
  recoverRelays,
  relayDialGate,
  dialledRelayUrl,
  withdrawDiscoveredRelays,
} from '../../../src/lib/relay/index.ts';
import { PublishedCarrierSet } from '../../../src/lib/runtime/published-carriers.ts';
import type { DaemonRelayCarrierEntry } from '../../../src/lib/runtime/carriers.ts';

const DISCOVERY: DaemonRelayCarrierEntry = { kind: 'relay', source: 'discovery', enabled: true, reconnectSeconds: 5 };
const SWITCHED_OFF: DaemonRelayCarrierEntry = { ...DISCOVERY, enabled: false };
const EXPLICIT_OFF: DaemonRelayCarrierEntry = {
  kind: 'relay',
  url: 'wss://mine.example/rendezvous',
  enabled: false,
  reconnectSeconds: 5,
};
const AVAILABLE: RelayAdvertisement = { kind: 'available', relayUrl: 'wss://relay.example/rendezvous' };
const DIRECT_ONLY: RelayCarrierSource = { kind: 'direct-only', reason: 'the directory could not be reached' };

class FakeCarrier implements RecoverableCarrier {
  readonly events: string[];
  constructor(events: string[]) {
    this.events = events;
  }
  start(): void {
    this.events.push('start');
  }
  stop(): void {
    this.events.push('stop');
  }
}

/** A promise a test settles by hand. */
function gate<T>() {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  return { promise, resolve, reject };
}

function harness(overrides: Partial<RelayRecoveryPorts<FakeCarrier>> = {}) {
  const events: string[] = [];
  const said: string[] = [];
  const published: (readonly RelayCarrierSource[])[] = [];
  let stopped = false;
  let current: readonly DaemonRelayCarrierEntry[] = [DISCOVERY];
  const ports: RelayRecoveryPorts<FakeCarrier> = {
    bootRelays: [DISCOVERY],
    bootFailure: 'this daemon could not reach the relay directory',
    sourcesNow: () => [DIRECT_ONLY],
    readCurrentRelays: async () => current,
    stopped: () => stopped,
    build: async (fresh): Promise<{ readonly carriers: readonly RecoveredCarrier<FakeCarrier>[] }> => {
      events.push('build');
      return { carriers: fresh.map(source => ({ carrier: new FakeCarrier(events), source })) };
    },
    hold: () => events.push('hold'),
    publish: sources => {
      events.push('publish');
      published.push(sources);
    },
    say: line => said.push(line),
    ...overrides,
  };
  return {
    ports,
    events,
    said,
    published,
    stop: () => {
      stopped = true;
    },
    configure: (entries: readonly DaemonRelayCarrierEntry[]) => {
      current = entries;
    },
  };
}

describe('recoverRelays', () => {
  it('should build, hold, start and publish the hosted carrier when nothing changed', async () => {
    // Arrange
    const h = harness();

    // Act
    await recoverRelays(h.ports, { advertisement: AVAILABLE, attempts: 3 });

    // Assert
    should(h.events).deepEqual(['build', 'hold', 'start', 'publish']);
    should(h.said).have.length(1);
    should(h.said[0]).match(/relay carrier recovered/u);
  });

  it('should drop a late success when the operator switched the discovery entry off meanwhile', async () => {
    // Arrange — boot saw the default entry and a failing network; the entry is switched off before the answer.
    const h = harness();
    h.configure([SWITCHED_OFF]);

    // Act
    await recoverRelays(h.ports, { advertisement: AVAILABLE, attempts: 2 });

    // Assert — nothing was even built, and the operator is told why.
    should(h.events).be.empty();
    should(h.said).have.length(1);
    should(h.said[0]).match(/configuration changed/u);
  });

  it('should drop a late success when an explicit relay block (disabled included) now applies', async () => {
    // Arrange
    const h = harness();
    h.configure([EXPLICIT_OFF]);

    // Act
    await recoverRelays(h.ports, { advertisement: AVAILABLE, attempts: 2 });

    // Assert
    should(h.events).be.empty();
  });

  it('should fail closed when the current configuration cannot be read', async () => {
    // Arrange
    const h = harness({
      readCurrentRelays: async () => {
        throw new Error('the document is mid-write');
      },
    });

    // Act
    await recoverRelays(h.ports, { advertisement: AVAILABLE, attempts: 2 });

    // Assert
    should(h.events).be.empty();
    should(h.said[0]).match(/cannot be read/u);
  });

  it('should re-check the configuration after the factory, before starting or publishing anything', async () => {
    // Arrange — the document is switched off while the carrier is still being built.
    const built = gate<void>();
    const h = harness();
    const baseBuild = h.ports.build;
    const ports: RelayRecoveryPorts<FakeCarrier> = {
      ...h.ports,
      build: async fresh => {
        const made = await baseBuild(fresh);
        await built.promise;
        return made;
      },
    };

    // Act
    const running = recoverRelays(ports, { advertisement: AVAILABLE, attempts: 2 });
    await Promise.resolve();
    await Promise.resolve();
    h.configure([SWITCHED_OFF]);
    built.resolve();
    await running;

    // Assert — the built carrier was discarded unstarted and unpublished.
    should(h.events).deepEqual(['build', 'stop']);
    should(h.published).be.empty();
  });

  it('should not start or publish when the daemon began stopping while the factory was running', async () => {
    // Arrange
    const built = gate<void>();
    const h = harness();
    const baseBuild = h.ports.build;
    const ports: RelayRecoveryPorts<FakeCarrier> = {
      ...h.ports,
      build: async fresh => {
        const made = await baseBuild(fresh);
        await built.promise;
        return made;
      },
    };

    // Act
    const running = recoverRelays(ports, { advertisement: AVAILABLE, attempts: 2 });
    await Promise.resolve();
    await Promise.resolve();
    h.stop();
    built.resolve();
    await running;

    // Assert
    should(h.events).deepEqual(['build', 'stop']);
    should(h.published).be.empty();
  });

  it('should not build anything when the daemon began stopping while the configuration was being read', async () => {
    // Arrange
    const read = gate<readonly DaemonRelayCarrierEntry[]>();
    const h = harness({ readCurrentRelays: async () => await read.promise });

    // Act
    const running = recoverRelays(h.ports, { advertisement: AVAILABLE, attempts: 2 });
    h.stop();
    read.resolve([DISCOVERY]);
    await running;

    // Assert
    should(h.events).be.empty();
    should(h.said).be.empty();
  });

  it('should do nothing at all once stopped', async () => {
    // Arrange
    const h = harness();
    h.stop();

    // Act
    await recoverRelays(h.ports, { advertisement: AVAILABLE, attempts: 2 });

    // Assert
    should(h.events).be.empty();
    should(h.said).be.empty();
  });

  it('should keep a definitive disabled answer direct-only, said once, without building', async () => {
    // Arrange
    const h = harness();

    // Act
    await recoverRelays(h.ports, { advertisement: { kind: 'disabled' }, attempts: 2 });

    // Assert
    should(h.events).be.empty();
    should(h.said[0]).match(/stays direct-only/u);
  });
});

describe('recoverRelays — the other answers', () => {
  it('should refuse, said once, when the advertised relay is one the operator already wrote down', async () => {
    // Arrange — the configured entry and the discovery entry resolve to one rendezvous.
    const mine: DaemonRelayCarrierEntry = {
      kind: 'relay',
      url: 'wss://relay.example/rendezvous',
      enabled: true,
      reconnectSeconds: 5,
    };
    const h = harness({ bootRelays: [DISCOVERY, mine] });
    h.configure([DISCOVERY, mine]);

    // Act
    await recoverRelays(h.ports, { advertisement: AVAILABLE, attempts: 2 });

    // Assert
    should(h.events).be.empty();
    should(h.said[0]).match(/relay carrier configuration refused/u);
  });

  it('should say a definitive undetermined answer once and keep the daemon direct-only', async () => {
    const h = harness();
    await recoverRelays(h.ports, {
      advertisement: { kind: 'undetermined', reason: 'a document it cannot read' },
      attempts: 2,
    });
    should(h.events).be.empty();
    should(h.said[0]).match(/a document it cannot read; this daemon stays direct-only/u);
  });

  it('should say the factory\u2019s refusal, and nothing when it was stopped meanwhile', async () => {
    const refusing = harness({ build: async () => ({ refusal: 'no identity' }) });
    await recoverRelays(refusing.ports, { advertisement: AVAILABLE, attempts: 2 });
    should(refusing.said).deepEqual(['no relay carriers — no identity']);

    const stoppedMeanwhile = harness();
    const ports: RelayRecoveryPorts<FakeCarrier> = {
      ...stoppedMeanwhile.ports,
      build: async () => {
        stoppedMeanwhile.stop();
        return { refusal: 'no identity' };
      },
    };
    await recoverRelays(ports, { advertisement: AVAILABLE, attempts: 2 });
    should(stoppedMeanwhile.said).be.empty();
  });

  it('should not let a carrier that fails to stop keep a dropped recovery from ending', async () => {
    // Arrange — the document changes while the factory runs, and the carrier it built throws on stop.
    const h = harness();
    const ports: RelayRecoveryPorts<FakeCarrier> = {
      ...h.ports,
      build: async fresh => {
        h.configure([SWITCHED_OFF]);
        return {
          carriers: fresh.map(source => ({
            carrier: {
              start: () => undefined,
              stop: () => {
                throw new Error('stop failed');
              },
            } as unknown as FakeCarrier,
            source,
          })),
        };
      },
    };

    // Act / Assert
    await recoverRelays(ports, { advertisement: AVAILABLE, attempts: 2 });
    should(h.published).be.empty();
  });
});

describe('relayDialGate', () => {
  const passing = {
    bootRelays: [DISCOVERY],
    readCurrentRelays: async (): Promise<readonly DaemonRelayCarrierEntry[]> => [DISCOVERY],
    stopped: () => false,
  };

  it('should say go only when running, readable and unchanged', async () => {
    should(await relayDialGate(passing)).deepEqual({ kind: 'go' });
  });

  it('should refuse once stopped, without reading the configuration', async () => {
    let reads = 0;
    const verdict = await relayDialGate({
      ...passing,
      readCurrentRelays: async () => {
        reads += 1;
        return [DISCOVERY];
      },
      stopped: () => true,
    });
    should(verdict).deepEqual({ kind: 'stopped' });
    should(reads).equal(0);
  });

  it('should fail closed on an unreadable configuration rather than accept a last-good one', async () => {
    const verdict = await relayDialGate({
      ...passing,
      readCurrentRelays: async () => {
        throw new Error('unreadable');
      },
    });
    should(verdict).deepEqual({ kind: 'unreadable' });
  });

  it('should refuse a changed configuration', async () => {
    const verdict = await relayDialGate({ ...passing, readCurrentRelays: async () => [SWITCHED_OFF] });
    should(verdict).deepEqual({ kind: 'changed' });
  });
});

describe('withdrawDiscoveredRelays — a vetoed relay is no longer promised', () => {
  const discovered: RelayCarrierSource = {
    kind: 'discovered',
    config: { url: 'wss://relay.example/rendezvous', enabled: true, reconnectSeconds: 5 },
  };
  const mine: RelayCarrierSource = {
    kind: 'configured',
    config: { url: 'wss://mine.example/rendezvous', enabled: true, reconnectSeconds: 5 },
  };

  it('should turn only the discovered sources direct-only, in place, with the reason', () => {
    // Act
    const after = withdrawDiscoveredRelays([mine, discovered], 'the configuration changed');

    // Assert
    should(after).deepEqual([mine, { kind: 'direct-only', reason: 'the configuration changed' }]);
  });

  it('should withdraw the relay from the published set (GET /v1/carriers and pairing redemption) and from discovery', () => {
    // Arrange — the boot published what the directory advertised.
    const published = new PublishedCarrierSet('http://127.0.0.1:4123', [mine, discovered]);
    should(published.current().filter(carrier => carrier.kind === 'relay')).have.length(2);

    // Act — the dial was vetoed.
    const after = withdrawDiscoveredRelays([mine, discovered], 'vetoed');
    published.relaysChanged(after);

    // Assert — the one published object both surfaces read lists only the relay that is still dialled, and
    // the source list pairing’s provenance getter reads has no relay left to disclose.
    should(published.current().filter(carrier => carrier.kind === 'relay')).deepEqual([
      { kind: 'relay', url: 'wss://mine.example/rendezvous' },
    ]);
    should(after.filter(source => source.kind === 'discovered')).be.empty();
    should(after.map(dialledRelayUrl)).deepEqual(['wss://mine.example/rendezvous', undefined]);
  });
});
