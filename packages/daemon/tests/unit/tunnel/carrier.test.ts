/**
 * The hosted tunnel carrier end to end on the daemon, against fakes for every port: what it plans, what
 * it provisions and renews, what it publishes and when, what it releases, and every sentence it says.
 */

import { beforeAll, beforeEach, describe, it } from 'bun:test';
import type { DaemonIdentity } from '@ferretry/relay';
import should from 'should';
import { DaemonTunnelCarrierSchema } from '../../../src/lib/runtime/carriers.ts';
import {
  CLOUDFLARED_NOT_ON_PATH,
  type CloudflaredLocation,
  describeTunnelPosture,
  NO_TUNNEL_SERVICE,
  TunnelCarrier,
  type TunnelCarrierDependencies,
  type TunnelHolding,
  type TunnelServiceAvailability,
} from '../../../src/lib/tunnel/index.ts';
import {
  FakeConnectorProcesses,
  FakeProvisioner,
  ManualScheduler,
  newDaemonIdentity,
  provisionOf,
  RecordedNotices,
  registered,
  testCrypto,
  unregistered,
} from './support.ts';

/** The entry an operator writes to turn the tunnel on: no `enabled` key means on. */
const TUNNEL_ON = DaemonTunnelCarrierSchema.parse({ kind: 'tunnel', source: 'discovery' });

const ORIGIN = 'https://ferretry-hosted-relay.example.workers.dev';
const OFF = { kind: 'tunnel', source: 'discovery', enabled: false } as const;
const CLOUDFLARED: CloudflaredLocation = { kind: 'found', path: '/usr/bin/cloudflared', via: 'path' };

let identity: DaemonIdentity;

beforeAll(async () => {
  identity = await newDaemonIdentity();
});

class MemoryHolding {
  held: TunnelHolding | undefined;
  readonly writes: TunnelHolding[] = [];

  async read() {
    return this.held;
  }

  async record(holding: TunnelHolding) {
    this.held = holding;
    this.writes.push(holding);
  }

  async forget() {
    this.held = undefined;
  }
}

interface World {
  readonly provisioner: FakeProvisioner;
  readonly processes: FakeConnectorProcesses;
  readonly scheduler: ManualScheduler;
  readonly notices: RecordedNotices;
  readonly holding: MemoryHolding;
  readonly published: (string | undefined)[];
  readonly listener: { opened: number; closed: number; readonly port: number };
  readonly serviceReads: number[];
}

let world: World;

beforeEach(() => {
  world = {
    provisioner: new FakeProvisioner(ORIGIN),
    processes: new FakeConnectorProcesses(),
    scheduler: new ManualScheduler(),
    notices: new RecordedNotices(),
    holding: new MemoryHolding(),
    published: [],
    listener: { opened: 0, closed: 0, port: 41_234 },
    serviceReads: [],
  };
});

function carrier(overrides: Partial<TunnelCarrierDependencies> = {}): TunnelCarrier {
  return new TunnelCarrier({
    entry: TUNNEL_ON,
    explicit: true,
    discoveryOrigin: ORIGIN,
    cloudflared: { locate: () => CLOUDFLARED },
    service: {
      read: async (): Promise<TunnelServiceAvailability> => {
        world.serviceReads.push(1);
        return { kind: 'available', origin: ORIGIN };
      },
    },
    holding: world.holding,
    identity: async () => ({ ok: true, identity }),
    crypto: testCrypto,
    provisioner: () => world.provisioner,
    openListener: async () => {
      world.listener.opened += 1;
      return {
        port: world.listener.port,
        close: async () => {
          world.listener.closed += 1;
        },
      };
    },
    processes: world.processes,
    scheduler: world.scheduler,
    random: () => 1,
    publish: url => world.published.push(url),
    notices: world.notices,
    ...overrides,
  });
}

/** Starts a carrier and waits for its first round with the hosted service. */
async function started(overrides: Partial<TunnelCarrierDependencies> = {}): Promise<TunnelCarrier> {
  const subject = carrier(overrides);
  subject.start();
  await subject.idle();
  return subject;
}

const settle = async () => {
  for (let round = 0; round < 10; round += 1) await Promise.resolve();
};

describe('the hosted tunnel carrier', () => {
  it('should provision with its own listener’s port and publish only once the connector registers', async () => {
    // Act
    const subject = await started();
    const beforeRegistration = [...world.published];
    world.processes.latest.say(registered(0));

    // Assert
    should(world.listener.opened).equal(1);
    should(world.provisioner.provisions[0]?.originPort).equal(41_234);
    should(world.provisioner.verdicts).deepEqual([true]);
    should(beforeRegistration).deepEqual([]);
    should(world.published).deepEqual(['https://quiet-otter.tunnels.example']);
    should(subject.published).equal('https://quiet-otter.tunnels.example');
    should(world.holding.held).deepEqual({ origin: ORIGIN, tunnelUrl: 'https://quiet-otter.tunnels.example' });
    should(world.notices.steps).deepEqual([
      'tunnel listener: 127.0.0.1:41234, serving only this daemon’s session route to the tunnel',
      'tunnel provisioned: https://quiet-otter.tunnels.example, renewing every 86400s',
      'tunnel connector registered: https://quiet-otter.tunnels.example',
    ]);
    should(world.notices.stated).deepEqual([]);
  });

  it('should keep the connector token out of everything it says and everything it records', async () => {
    // Act
    await started();
    world.processes.latest.say(registered(0));

    // Assert — the only place the token went is the child's environment.
    should(world.notices.all.includes('fake-connector-token-ONE')).be.false();
    should(JSON.stringify(world.holding.writes).includes('fake-connector-token-ONE')).be.false();
    should(world.processes.latest.command.args.join(' ').includes('fake-connector-token-ONE')).be.false();
    should(world.processes.latest.command.environment).deepEqual({ TUNNEL_TOKEN: 'fake-connector-token-ONE' });
  });

  it('should withdraw the tunnel while the connector is down and publish it again when it is back', async () => {
    // Arrange
    await started();
    world.processes.latest.say(registered(0));

    // Act
    world.processes.latest.exit(1);
    await settle();
    world.scheduler.fire();
    world.processes.latest.say(registered(0));

    // Assert
    should(world.published).deepEqual([
      'https://quiet-otter.tunnels.example',
      undefined,
      'https://quiet-otter.tunnels.example',
    ]);
    should(world.notices.stated).deepEqual([
      'tunnel withdrawn — cloudflared has no edge connection right now',
      'tunnel connector down — cloudflared exited (code 1); restarting in 1s',
    ]);
  });

  it('should renew every renewAfterSeconds, keeping a connector whose token did not change', async () => {
    // Arrange
    world.provisioner.provisionAnswers = [
      { kind: 'ok', value: provisionOf({ renewAfterSeconds: 3_600 }) },
      { kind: 'ok', value: provisionOf({ renewAfterSeconds: 3_600 }) },
    ];
    const subject = await started();
    world.processes.latest.say(registered(0));

    // Act
    const renewal = world.scheduler.armed;
    world.scheduler.fire();
    await subject.idle();

    // Assert
    should(renewal).deepEqual([3_600_000]);
    should(world.provisioner.provisions.length).equal(2);
    should(world.processes.spawned.length).equal(1);
    should(world.published).deepEqual(['https://quiet-otter.tunnels.example']);
    // The renewal is not a second announcement.
    should(world.notices.steps.filter(line => line.startsWith('tunnel provisioned')).length).equal(1);
    should(world.scheduler.armed).deepEqual([3_600_000]);
  });

  it('should restart the connector on a new token and move the published hostname with it', async () => {
    // Arrange
    world.provisioner.provisionAnswers = [
      { kind: 'ok', value: provisionOf() },
      {
        kind: 'ok',
        value: provisionOf({
          tunnelUrl: 'https://brave-heron.tunnels.example',
          connectorToken: 'fake-connector-token-TWO',
        }),
      },
    ];
    const subject = await started();
    world.processes.latest.say(registered(0));

    // Act
    world.scheduler.fire();
    await subject.idle();
    await settle();
    world.processes.latest.say(registered(0));

    // Assert
    should(world.processes.spawned.length).equal(2);
    should(world.processes.spawned[0]?.terminated).be.true();
    should(world.processes.latest.command.environment).deepEqual({ TUNNEL_TOKEN: 'fake-connector-token-TWO' });
    should(world.published).deepEqual([
      'https://quiet-otter.tunnels.example',
      undefined,
      'https://brave-heron.tunnels.example',
    ]);
    should(world.notices.steps).containEql(
      'tunnel provisioned: https://brave-heron.tunnels.example, renewing every 86400s',
    );
  });

  it('should retry a provisioning failure that may clear, with backoff, and say each one', async () => {
    // Arrange
    world.provisioner.provisionAnswers = [
      { kind: 'refused', status: 503, code: 'tunnel_capacity', message: 'every account is full' },
      { kind: 'failed', reason: 'this daemon could not reach the hosted tunnel service' },
    ];
    const subject = await started();

    // Act
    const first = world.scheduler.armed;
    world.scheduler.fire();
    await subject.idle();
    const second = world.scheduler.armed;
    world.scheduler.fire();
    await subject.idle();

    // Assert — the success resets the backoff and arms the renewal instead.
    should(first).deepEqual([5_000]);
    should(second).deepEqual([10_000]);
    should(world.scheduler.armed).deepEqual([86_400_000]);
    should(world.notices.stated).deepEqual([
      'tunnel provisioning failed — the hosted service refused (tunnel_capacity, 503): every account is full; retrying in 5s',
      'tunnel provisioning failed — this daemon could not reach the hosted tunnel service; retrying in 10s',
    ]);
    should(world.processes.spawned.length).equal(1);
  });

  it('should turn itself off when the service rejects this daemon, releasing what it held', async () => {
    // Arrange
    world.provisioner.provisionAnswers = [
      { kind: 'ok', value: provisionOf() },
      { kind: 'refused', status: 401, code: 'tunnel_claim_rejected', message: 'signature failed' },
    ];
    const subject = await started();
    world.processes.latest.say(registered(0));

    // Act
    world.scheduler.fire();
    await subject.idle();

    // Assert
    should(world.notices.stated).containEql(
      'tunnel carrier off — the hosted service refused (tunnel_claim_rejected, 401): signature failed',
    );
    should(world.processes.latest.terminated).be.true();
    should(world.published).deepEqual(['https://quiet-otter.tunnels.example', undefined]);
    should(world.listener.closed).equal(1);
    should(world.scheduler.armed).deepEqual([]);
    await subject.stop();
    should(world.listener.closed).equal(1);
  });

  it('should be off, with the remedy, when cloudflared is absent — and ask the service nothing', async () => {
    // Act
    await started({ cloudflared: { locate: () => CLOUDFLARED_NOT_ON_PATH } });

    // Assert
    should(world.serviceReads).deepEqual([]);
    should(world.listener.opened).equal(0);
    should(world.notices.stated.length).equal(1);
    should(world.notices.stated[0]).match(/^tunnel carrier off — cloudflared is not on this daemon’s PATH/u);
  });

  it('should be off, saying why, when the hosted service does not provision tunnels', async () => {
    // Act
    await started({ service: { read: async () => NO_TUNNEL_SERVICE } });

    // Assert
    should(world.notices.stated).deepEqual(['tunnel carrier off — this build carries no hosted service to ask']);
    should(world.listener.opened).equal(0);
  });

  it('should be off when there is no identity to sign with', async () => {
    // Act
    await started({ identity: async () => ({ ok: false, reason: 'the daemon identity has not been created yet' }) });

    // Assert
    should(world.notices.stated).deepEqual(['tunnel carrier off — the daemon identity has not been created yet']);
    should(world.listener.opened).equal(0);
  });

  it('should turn a fault into its off sentence rather than a failed boot', async () => {
    // Act
    await started({
      openListener: async () => {
        throw new Error('there is no session route to serve — no identity');
      },
    });
    await started({
      openListener: async () => {
        throw 'refused';
      },
    });

    // Assert
    should(world.notices.stated).deepEqual([
      'tunnel carrier off — there is no session route to serve — no identity',
      'tunnel carrier off — refused',
    ]);
  });

  it('should stop: withdraw, end the connector, close the listener and arm nothing more', async () => {
    // Arrange
    const subject = await started();
    world.processes.latest.say(registered(0));

    // Act
    await subject.stop();
    world.scheduler.fire();
    await subject.idle();

    // Assert
    should(world.published).deepEqual(['https://quiet-otter.tunnels.example', undefined]);
    should(world.processes.latest.terminated).be.true();
    should(world.listener.closed).equal(1);
    should(world.provisioner.provisions.length).equal(1);
    // Nothing about the stop is a fault the operator must read.
    should(world.notices.stated).deepEqual([]);
  });

  it('should close a listener that finished opening after the stop', async () => {
    // Arrange — the listener opens only once the test lets it.
    let open: () => void = () => undefined;
    const subject = carrier({
      openListener: async () => {
        await new Promise<void>(resolve => {
          open = resolve;
        });
        world.listener.opened += 1;
        return {
          port: 1,
          close: async () => {
            world.listener.closed += 1;
          },
        };
      },
    });
    subject.start();
    await settle();

    // Act
    const stopping = subject.stop();
    open();
    await stopping;

    // Assert
    should([world.listener.opened, world.listener.closed]).deepEqual([1, 1]);
    should(world.provisioner.provisions).deepEqual([]);
  });

  it('should go no further than any step a stop interrupted', async () => {
    // A stop that lands while the service is being asked, while the identity is read, or while a
    // provision is in flight leaves nothing behind it.
    for (const pause of ['service', 'identity', 'provision'] as const) {
      // Arrange
      world = { ...world, published: [], processes: new FakeConnectorProcesses(), notices: new RecordedNotices() };
      let release: () => void = () => undefined;
      const gate = new Promise<void>(resolve => {
        release = resolve;
      });
      const provisioner = new FakeProvisioner(ORIGIN);
      const subject = carrier({
        service: {
          read: async () => {
            if (pause === 'service') await gate;
            return { kind: 'available', origin: ORIGIN };
          },
        },
        identity: async () => {
          if (pause === 'identity') await gate;
          return { ok: true, identity };
        },
        provisioner: () => ({
          origin: ORIGIN,
          challenge: async request => await provisioner.challenge(request),
          provision: async request => {
            if (pause === 'provision') await gate;
            return await provisioner.provision(request);
          },
          release: async request => await provisioner.release(request),
        }),
      });
      subject.start();
      await settle();

      // Act
      const stopping = subject.stop();
      release();
      await stopping;

      // Assert
      should(world.processes.spawned).deepEqual([]);
      should(world.published).deepEqual([]);
      should(world.notices.stated).deepEqual([]);
    }
  });

  it('should say nothing about a connector that dies after the daemon stopped', async () => {
    // Arrange
    world.processes.stubborn = true;
    const subject = await started();
    world.processes.latest.say(registered(0));
    const child = world.processes.latest;

    // Act
    const stopping = subject.stop();
    child.exit(1);
    await stopping;

    // Assert
    should(world.notices.stated).deepEqual([]);
  });

  it('should keep quiet about a connector line or restart after a stop', async () => {
    // Arrange — the connector fails to start, then the daemon stops before the restart fires.
    world.processes.failNext = new Error('ENOENT');
    const subject = await started();
    await subject.stop();

    // Act
    world.scheduler.fire();

    // Assert
    should(world.notices.stated.length).equal(1);
    should(world.processes.spawned).deepEqual([]);
  });
});

describe('switching the hosted tunnel off', () => {
  it('should say so, and ask nothing when this daemon holds no tunnel', async () => {
    // Act
    await started({ entry: OFF });

    // Assert
    should(world.notices.steps).deepEqual(['tunnel carrier switched off: by its { "kind": "tunnel" } entry']);
    should(world.provisioner.challenges).deepEqual([]);
    should(world.listener.opened).equal(0);
    should(world.serviceReads).deepEqual([]);
  });

  it('should release a tunnel an earlier boot provisioned, signed for the discovered host', async () => {
    // Arrange
    world.holding.held = { origin: ORIGIN, tunnelUrl: 'https://quiet-otter.tunnels.example' };

    // Act
    await started({ entry: OFF });

    // Assert
    should(world.provisioner.releases.length).equal(1);
    should(world.provisioner.verdicts).deepEqual([true]);
    should(world.holding.held).be.undefined();
    should(world.notices.steps).containEql(
      'tunnel released: https://quiet-otter.tunnels.example, because the tunnel carrier is switched off',
    );
  });

  it('should forget the record when the service answers it held no tunnel, and not ask again', async () => {
    // Arrange — reclaimed, or released by an earlier boot whose record survived.
    world.holding.held = { origin: ORIGIN, tunnelUrl: 'https://quiet-otter.tunnels.example' };
    world.provisioner.releaseAnswers = [{ kind: 'ok', value: { version: 1, released: false } }];

    // Act
    await started({ entry: OFF });
    await started({ entry: OFF });

    // Assert
    should(world.provisioner.releases.length).equal(1);
    should(world.holding.held).be.undefined();
    should(world.notices.steps).containEql(
      'tunnel released: the hosted service held no tunnel for this daemon any more (https://quiet-otter.tunnels.example)',
    );
  });

  it('should not sign a release for a service it no longer discovers', async () => {
    // Arrange
    world.holding.held = { origin: 'https://old-service.example', tunnelUrl: 'https://quiet-otter.tunnels.example' };

    // Act
    await started({ entry: OFF });
    await started({ entry: OFF, discoveryOrigin: undefined });

    // Assert
    should(world.provisioner.challenges).deepEqual([]);
    should(world.holding.held).not.be.undefined();
    should(world.notices.stated.length).equal(2);
    should(world.notices.stated[0]).match(
      /holds https:\/\/quiet-otter\.tunnels\.example from https:\/\/old-service\.example/u,
    );
  });

  it('should keep the record and say so when the release cannot happen this boot', async () => {
    // Arrange
    world.holding.held = { origin: ORIGIN, tunnelUrl: 'https://quiet-otter.tunnels.example' };
    world.provisioner.releaseAnswers = [
      { kind: 'failed', reason: 'this daemon could not reach the hosted tunnel service' },
    ];

    // Act
    await started({ entry: OFF });
    await started({ entry: OFF, identity: async () => ({ ok: false, reason: 'no identity' }) });

    // Assert
    should(world.holding.held).not.be.undefined();
    should(world.notices.stated).deepEqual([
      'tunnel release failed — this daemon could not reach the hosted tunnel service; the next boot tries again',
      'tunnel release skipped — no identity; the next boot tries again',
    ]);
  });
});

describe('the tunnel carrier’s status', () => {
  it('should move provisioning → connecting → up → connecting as the connector registers and drops', async () => {
    // Arrange
    const subject = carrier();
    const before = subject.status;

    // Act
    subject.start();
    await subject.idle();
    const provisioned = subject.status;
    world.processes.latest.say(registered(0));
    const published = subject.status;
    world.processes.latest.say(unregistered(0));
    const dropped = subject.status;

    // Assert
    should(before).deepEqual({ state: 'provisioning', tunnelUrl: undefined, reason: undefined });
    should(provisioned).deepEqual({
      state: 'connecting',
      tunnelUrl: 'https://quiet-otter.tunnels.example',
      reason: undefined,
    });
    should(published.state).equal('up');
    should(dropped.state).equal('connecting');
  });

  it('should stay provisioning through a retry, with the retry as its reason', async () => {
    // Arrange
    world.provisioner.provisionAnswers = [
      { kind: 'failed', reason: 'this daemon could not reach the hosted tunnel service' },
    ];

    // Act
    const subject = await started();

    // Assert
    should(subject.status).deepEqual({
      state: 'provisioning',
      tunnelUrl: undefined,
      reason: 'provisioning failed — this daemon could not reach the hosted tunnel service; retrying in 5s',
    });
  });

  it('should be unavailable, with the reason and no hostname, when it cannot run', async () => {
    // Act
    const absent = await started({ cloudflared: { locate: () => CLOUDFLARED_NOT_ON_PATH } });
    const unprovisioned = await started({ service: { read: async () => NO_TUNNEL_SERVICE } });

    // Assert
    should(absent.status.state).equal('unavailable');
    should(absent.status.reason).match(/^cloudflared is not on this daemon’s PATH/u);
    should(unprovisioned.status).deepEqual({
      state: 'unavailable',
      tunnelUrl: undefined,
      reason: 'this build carries no hosted service to ask',
    });
  });

  it('should be off when its entry is off', async () => {
    // Act
    const subject = await started({ entry: OFF });

    // Assert
    should(subject.status).deepEqual({ state: 'off', tunnelUrl: undefined, reason: undefined });
  });
});

describe('the opt-in default', () => {
  it('should say how to turn the tunnel on when nobody switched it off, and ask nothing', async () => {
    // Act
    await started({ entry: OFF, explicit: false });

    // Assert
    should(world.notices.steps).deepEqual(['tunnel carrier off (opt-in): turn on with `fy daemon tunnel on`']);
    should(world.notices.stated).deepEqual([]);
    should(world.serviceReads).deepEqual([]);
    should(world.listener.opened).equal(0);
  });

  it('should release the tunnel the old implied-on default provisioned, and say why and how to turn it on', async () => {
    // Arrange — a daemon updated from the release where an undeclared tunnel was implied on.
    world.holding.held = { origin: ORIGIN, tunnelUrl: 'https://quiet-otter.tunnels.example' };

    // Act
    await started({ entry: OFF, explicit: false });

    // Assert
    should(world.provisioner.releases.length).equal(1);
    should(world.provisioner.verdicts).deepEqual([true]);
    should(world.holding.held).be.undefined();
    should(world.notices.stated).deepEqual([
      'tunnel carrier off (opt-in) — released https://quiet-otter.tunnels.example; turn on with `fy daemon tunnel on`',
    ]);
  });

  it('should say the service held nothing in the ordinary words, even for the default', async () => {
    // Arrange
    world.holding.held = { origin: ORIGIN, tunnelUrl: 'https://quiet-otter.tunnels.example' };
    world.provisioner.releaseAnswers = [{ kind: 'ok', value: { version: 1, released: false } }];

    // Act
    await started({ entry: OFF, explicit: false });

    // Assert
    should(world.notices.steps).containEql(
      'tunnel released: the hosted service held no tunnel for this daemon any more (https://quiet-otter.tunnels.example)',
    );
  });
});

describe('the tunnel posture', () => {
  const posture = (input: Partial<Parameters<typeof describeTunnelPosture>[0]>) =>
    describeTunnelPosture({
      entry: TUNNEL_ON,
      explicit: true,
      configFile: '/home/me/.ferretry/config/daemon.json',
      location: CLOUDFLARED,
      availability: { kind: 'available', origin: ORIGIN },
      ...input,
    });

  it('should state each posture in one line under the tunnel label', () => {
    should(posture({})).equal(
      `tunnel       hosted — provisioned at boot from ${ORIGIN}, run by cloudflared at /usr/bin/cloudflared`,
    );
    should(posture({ entry: OFF })).equal('tunnel       off — switched off in /home/me/.ferretry/config/daemon.json');
    // Nobody switched it off: the opt-in default says how to turn it on instead of naming a file.
    should(posture({ entry: OFF, explicit: false })).equal(
      'tunnel       off (opt-in) — turn on with `fy daemon tunnel on`',
    );
    should(posture({ location: CLOUDFLARED_NOT_ON_PATH })).match(
      /^tunnel {7}off — cloudflared is not on this daemon’s PATH/u,
    );
    should(posture({ location: undefined })).match(/^tunnel {7}off — cloudflared was not looked for/u);
    should(posture({ availability: NO_TUNNEL_SERVICE })).equal(
      'tunnel       off — this build carries no hosted service to ask',
    );
    should(posture({ availability: undefined })).equal('tunnel       off — the hosted service was not asked');
  });
});
