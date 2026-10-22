/**
 * The tunnel switch against fake carriers and a fake document: what it writes, which carrier it starts
 * or stops, that an OFF waits for the release, that two changes never interleave, and what it reports.
 */

import { beforeEach, describe, it } from 'bun:test';
import { TUNNEL_OFF_SENTENCE } from '@ferretry/protocol';
import should from 'should';
import type { DaemonTunnelCarrierEntry } from '../../../src/lib/runtime/carriers.ts';
import {
  describeTunnelStatus,
  type TunnelCarrierHandle,
  type TunnelCarrierStatus,
  TunnelCarrierSwitch,
} from '../../../src/lib/tunnel/index.ts';

const ON: DaemonTunnelCarrierEntry = { kind: 'tunnel', source: 'discovery', enabled: true };
const OFF: DaemonTunnelCarrierEntry = { kind: 'tunnel', source: 'discovery', enabled: false };
const URL_ = 'https://quiet-otter.tunnels.example';

/** A carrier that records its life, and whose idle resolves only when the test releases it. */
class FakeCarrier implements TunnelCarrierHandle {
  started = false;
  stopped = false;
  status: TunnelCarrierStatus;
  #release: () => void = () => undefined;
  readonly #idle: Promise<void>;

  constructor(
    readonly entry: DaemonTunnelCarrierEntry,
    readonly explicit: boolean,
    readonly log: string[],
  ) {
    this.status = { state: entry.enabled ? 'provisioning' : 'off', tunnelUrl: undefined, reason: undefined };
    this.#idle = new Promise(resolve => {
      this.#release = resolve;
    });
  }

  start(): void {
    this.started = true;
    this.log.push(`start ${this.entry.enabled ? 'on' : 'off'}${this.explicit ? '' : ' (implied)'}`);
  }

  async idle(): Promise<void> {
    await this.#idle;
    this.log.push(`idle ${this.entry.enabled ? 'on' : 'off'}`);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.log.push(`stop ${this.entry.enabled ? 'on' : 'off'}`);
  }

  settle(): void {
    this.#release();
  }
}

interface World {
  readonly log: string[];
  readonly carriers: FakeCarrier[];
  readonly writes: DaemonTunnelCarrierEntry[];
  /** When set, the store's next write throws this. */
  failWrite: Error | undefined;
  /** When true, every carrier settles as soon as it is made. */
  autoSettle: boolean;
}

let world: World;

beforeEach(() => {
  world = { log: [], carriers: [], writes: [], failWrite: undefined, autoSettle: true };
});

function subject(entry: DaemonTunnelCarrierEntry = OFF, explicit = false): TunnelCarrierSwitch {
  return new TunnelCarrierSwitch({
    entry,
    explicit,
    store: {
      write: async written => {
        if (world.failWrite !== undefined) throw world.failWrite;
        world.writes.push(written);
        world.log.push(`write ${written.enabled ? 'on' : 'off'}`);
      },
    },
  });
}

const factory = (entry: DaemonTunnelCarrierEntry, explicit: boolean): FakeCarrier => {
  const carrier = new FakeCarrier(entry, explicit, world.log);
  world.carriers.push(carrier);
  if (world.autoSettle) carrier.settle();
  return carrier;
};

describe('the tunnel switch', () => {
  it('should start the carrier the document asks for, once, when the boot reaches it', () => {
    // Arrange
    const tunnel = subject(OFF, false);

    // Act
    tunnel.start(factory);
    tunnel.start(factory);

    // Assert
    should(world.log).deepEqual(['start off (implied)']);
    should(tunnel.view()).deepEqual({
      enabled: false,
      explicit: false,
      state: 'off',
      tunnelUrl: null,
      sentence: TUNNEL_OFF_SENTENCE,
    });
  });

  it('should switch on: write the entry, stop the off carrier and start an explicit on one', async () => {
    // Arrange
    const tunnel = subject(OFF, false);
    tunnel.start(factory);

    // Act
    const view = await tunnel.change(true);

    // Assert
    should(world.writes).deepEqual([ON]);
    should(world.log).deepEqual(['start off (implied)', 'write on', 'stop off', 'start on']);
    should(view).deepEqual({
      enabled: true,
      explicit: true,
      state: 'provisioning',
      tunnelUrl: null,
      sentence: 'Tunnel: on — asking the hosted service for a tunnel',
    });
  });

  it('should switch off: write, stop the running carrier and answer only once the release has finished', async () => {
    // Arrange
    world.autoSettle = false;
    const tunnel = subject(ON, true);
    tunnel.start(factory);

    // Act
    let answered = false;
    const pending = tunnel.change(false).then(view => {
      answered = true;
      return view;
    });
    for (let round = 0; round < 10; round += 1) await Promise.resolve();
    const beforeRelease = answered;
    world.carriers[1]?.settle();
    const view = await pending;

    // Assert
    should(beforeRelease).be.false();
    should(world.log).deepEqual(['start on', 'write off', 'stop on', 'start off', 'idle off']);
    should(world.carriers[0]?.stopped).be.true();
    should(view.state).equal('off');
    should(view.explicit).be.true();
    should(view.sentence).equal(
      'Tunnel: off — switched off for this machine; turn on with fy daemon tunnel on or Settings › Connection',
    );
  });

  it('should keep a running tunnel when asked to switch on again, and still write the entry', async () => {
    // Arrange
    const tunnel = subject(ON, false);
    tunnel.start(factory);

    // Act
    await tunnel.change(true);

    // Assert
    should(world.log).deepEqual(['start on (implied)', 'write on']);
    should(world.carriers.length).equal(1);
    should(tunnel.view().explicit).be.true();
  });

  it('should replace an unavailable carrier when asked on again, so installing cloudflared then retrying works', async () => {
    // Arrange
    const tunnel = subject(ON, true);
    tunnel.start(factory);
    (world.carriers[0] as FakeCarrier).status = {
      state: 'unavailable',
      tunnelUrl: undefined,
      reason: 'cloudflared is not on this daemon’s PATH',
    };

    // Act
    const view = await tunnel.change(true);

    // Assert
    should(world.log).deepEqual(['start on', 'write on', 'stop on', 'start on']);
    should(view.state).equal('provisioning');
  });

  it('should replace an off carrier when asked off again, so a release that found no answer is retried', async () => {
    // Arrange
    const tunnel = subject(OFF, true);
    tunnel.start(factory);

    // Act
    await tunnel.change(false);

    // Assert
    should(world.log).deepEqual(['start off', 'write off', 'stop off', 'start off', 'idle off']);
  });

  it('should serialise two changes, so a stop never races a start', async () => {
    // Arrange
    const tunnel = subject(OFF, false);
    tunnel.start(factory);

    // Act
    const [on, off] = await Promise.all([tunnel.change(true), tunnel.change(false)]);

    // Assert
    should(world.log).deepEqual([
      'start off (implied)',
      'write on',
      'stop off',
      'start on',
      'write off',
      'stop on',
      'start off',
      'idle off',
    ]);
    should(on.enabled).be.true();
    should(off.enabled).be.false();
  });

  it('should leave the running carrier alone when the document cannot be written, and keep serving changes', async () => {
    // Arrange
    const tunnel = subject(OFF, false);
    tunnel.start(factory);
    world.failWrite = new Error('the configuration document could not be written');

    // Act
    const refused = await tunnel.change(true).catch((error: unknown) => error);
    world.failWrite = undefined;
    const view = await tunnel.change(true);

    // Assert
    should(refused).be.instanceOf(Error);
    should((refused as Error).message).equal('the configuration document could not be written');
    should(world.log).deepEqual(['start off (implied)', 'write on', 'stop off', 'start on']);
    should(view.enabled).be.true();
  });

  it('should record a change asked before the boot started it, and start what the document says by then', async () => {
    // Arrange
    const tunnel = subject(OFF, false);

    // Act
    const early = await tunnel.change(true);
    tunnel.start(factory);

    // Assert
    should(early).deepEqual({
      enabled: true,
      explicit: true,
      state: 'provisioning',
      tunnelUrl: null,
      sentence: 'Tunnel: on — asking the hosted service for a tunnel',
    });
    should(world.log).deepEqual(['write on', 'start on']);
  });

  it('should stop the running carrier for good, and start nothing afterwards', async () => {
    // Arrange
    const tunnel = subject(ON, true);
    tunnel.start(factory);

    // Act
    await tunnel.stop();
    const view = await tunnel.change(false);
    tunnel.start(factory);

    // Assert
    should(world.log).deepEqual(['start on', 'stop on', 'write off']);
    should(view.enabled).be.false();
  });

  it('should stop without ever having started, and refuse a later start', async () => {
    // Arrange
    const tunnel = subject(ON, true);

    // Act
    await tunnel.stop();
    tunnel.start(factory);

    // Assert
    should(world.log).deepEqual([]);
    should(tunnel.view().state).equal('provisioning');
  });
});

describe('the tunnel status view', () => {
  const view = (status: Partial<TunnelCarrierStatus>, entry = ON, explicit = true) =>
    describeTunnelStatus({
      entry,
      explicit,
      status: { state: 'provisioning', tunnelUrl: undefined, reason: undefined, ...status },
    });

  it('should say one line for every state', () => {
    should(view({ state: 'off' }, OFF, false).sentence).equal(TUNNEL_OFF_SENTENCE);
    should(view({ state: 'unavailable', reason: 'this build carries no hosted service to ask' }).sentence).equal(
      'Tunnel: on, but unavailable — this build carries no hosted service to ask',
    );
    should(view({ state: 'unavailable' }).sentence).equal('Tunnel: on, but unavailable');
    should(view({ reason: 'provisioning failed — no answer; retrying in 5s' }).sentence).equal(
      'Tunnel: on — asking the hosted service for a tunnel — provisioning failed — no answer; retrying in 5s',
    );
    should(view({ state: 'connecting', tunnelUrl: URL_ }).sentence).equal(
      `Tunnel: on — ${URL_}, waiting for cloudflared to reach Cloudflare’s edge`,
    );
    should(view({ state: 'up', tunnelUrl: URL_ })).deepEqual({
      enabled: true,
      explicit: true,
      state: 'up',
      tunnelUrl: URL_,
      sentence: `Tunnel: up — ${URL_}`,
    });
  });
});
