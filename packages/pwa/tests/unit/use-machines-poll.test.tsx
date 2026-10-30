import { afterEach, describe, expect, test } from 'bun:test';
import {
  BACKGROUND_POLL_MS,
  backgroundPollMs,
  browserFleetPollEnvironment,
  FLEET_FEED_SAFETY_MS,
  FLEET_POLL_MS,
  type FleetPollEnvironment,
  type MachineFleetFeedOpener,
  PHONE_BACKGROUND_POLL_MS,
  useMachinesPoll,
} from '../../src/hooks/use-machines-poll.ts';
import { type DaemonConnection, type DaemonId, daemonConnection } from '../../src/lib/daemon-connection.ts';
import { FLEET_FEED_SETTLE_MS, type FleetFeedEnvironment } from '../../src/lib/fleet-feed.ts';
import '../support/dom.ts';
import { interact, type Mounted, mount } from '../support/dom.ts';

const alpha = daemonConnection({ daemonId: 'alpha', baseUrl: 'https://alpha.example.test', deviceId: 'alpha-device' });
const beta = daemonConnection({ daemonId: 'beta', baseUrl: 'https://beta.example.test', deviceId: 'beta-device' });

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

function Poller({
  fleet,
  machines,
  current,
  phone = false,
  environment,
  openFleetFeed,
  feedEnvironment,
  onFeedEvent,
}: {
  readonly fleet: { hydrate: (daemon: DaemonConnection) => Promise<readonly never[]> };
  readonly machines: readonly DaemonConnection[];
  readonly current: DaemonId | null;
  readonly phone?: boolean;
  readonly environment?: FleetPollEnvironment;
  readonly openFleetFeed?: MachineFleetFeedOpener;
  readonly feedEnvironment?: FleetFeedEnvironment;
  readonly onFeedEvent?: (daemonId: DaemonId, event: { readonly type: string }) => void;
}) {
  useMachinesPoll(
    fleet as never,
    machines,
    current,
    phone,
    environment,
    openFleetFeed,
    feedEnvironment,
    onFeedEvent as never,
  );
  return null;
}

const fakeEnvironment = () => {
  let visible = true;
  let time = 0;
  const ticks = new Map<number, () => void>();
  let onShow: (() => void) | undefined;
  const log: string[] = [];
  const environment: FleetPollEnvironment = {
    visible: () => visible,
    setInterval: (callback, milliseconds) => {
      log.push(`interval:${milliseconds}`);
      ticks.set(milliseconds, callback);
      return milliseconds;
    },
    clearInterval: handle => log.push(`clear:${String(handle)}`),
    onVisibility: callback => {
      onShow = callback;
      return () => log.push('released');
    },
    now: () => time,
  };
  return {
    environment,
    log,
    tick: (milliseconds: number) => ticks.get(milliseconds)?.(),
    show: () => {
      visible = true;
      onShow?.();
    },
    hide: () => {
      visible = false;
    },
    setTime: (milliseconds: number) => {
      time = milliseconds;
    },
  };
};

const recorder = () => {
  const reads: DaemonConnection[] = [];
  return { reads, fleet: { hydrate: async (daemon: DaemonConnection) => (reads.push(daemon), []) } };
};

describe('useMachinesPoll', () => {
  test('reads every machine on mount, the one on screen on the quick beat and the others on the slow one', async () => {
    const { reads, fleet } = recorder();
    const fake = fakeEnvironment();
    view = await mount(
      <Poller current={alpha.daemonId} environment={fake.environment} fleet={fleet} machines={[alpha, beta]} />,
    );
    expect(reads.map(read => String(read.daemonId))).toEqual(['alpha', 'beta']);
    expect(fake.log).toEqual([`interval:${FLEET_POLL_MS}`, `interval:${BACKGROUND_POLL_MS}`]);
    fake.tick(FLEET_POLL_MS);
    expect(String(reads.at(-1)?.daemonId)).toBe('alpha');
    fake.tick(BACKGROUND_POLL_MS);
    expect(String(reads.at(-1)?.daemonId)).toBe('beta');
    expect(reads).toHaveLength(4);

    // Hidden, nothing is read; back in sight, every machine at once.
    fake.hide();
    fake.tick(FLEET_POLL_MS);
    fake.tick(BACKGROUND_POLL_MS);
    expect(reads).toHaveLength(4);
    fake.show();
    expect(reads.slice(4).map(read => String(read.daemonId))).toEqual(['alpha', 'beta']);

    await view.unmount();
    view = null;
    expect(fake.log.slice(2)).toEqual([`clear:${FLEET_POLL_MS}`, `clear:${BACKGROUND_POLL_MS}`, 'released']);
  });

  test('a phone polls the machines not on screen at the slower beat', async () => {
    const { fleet } = recorder();
    const fake = fakeEnvironment();
    view = await mount(
      <Poller current={alpha.daemonId} environment={fake.environment} fleet={fleet} machines={[alpha]} phone />,
    );
    expect(fake.log).toEqual([`interval:${FLEET_POLL_MS}`, `interval:${PHONE_BACKGROUND_POLL_MS}`]);
    expect(backgroundPollMs(true)).toBe(PHONE_BACKGROUND_POLL_MS);
    expect(backgroundPollMs(false)).toBe(BACKGROUND_POLL_MS);
  });

  test('with no machine on screen every machine is a background one', async () => {
    const { reads, fleet } = recorder();
    const fake = fakeEnvironment();
    view = await mount(<Poller current={null} environment={fake.environment} fleet={fleet} machines={[alpha]} />);
    fake.tick(FLEET_POLL_MS);
    expect(reads).toHaveLength(1);
    fake.tick(BACKGROUND_POLL_MS);
    expect(reads).toHaveLength(2);
  });

  test('a new connection object for the same pairing does not restart the poll, but is the one read', async () => {
    const { reads, fleet } = recorder();
    const fake = fakeEnvironment();
    view = await mount(
      <Poller current={alpha.daemonId} environment={fake.environment} fleet={fleet} machines={[alpha]} />,
    );
    const replaced = daemonConnection({
      daemonId: 'alpha',
      baseUrl: 'https://alpha.example.test',
      deviceId: 'alpha-device',
    });
    await view.render(
      <Poller current={alpha.daemonId} environment={fake.environment} fleet={fleet} machines={[replaced]} />,
    );
    expect(reads).toHaveLength(1);
    fake.tick(FLEET_POLL_MS);
    expect(reads.at(-1)).toBe(replaced);
  });

  test('a failed read is swallowed: the slice already says so', async () => {
    const fake = fakeEnvironment();
    const fleet = { hydrate: async () => await Promise.reject(new Error('offline')) };
    view = await mount(
      <Poller current={alpha.daemonId} environment={fake.environment} fleet={fleet} machines={[alpha]} />,
    );
    await interact(async () => await Promise.resolve());
  });

  test('the browser environment reads the document and the real timers', () => {
    expect(browserFleetPollEnvironment.visible()).toBe(document.visibilityState !== 'hidden');
    let fired = 0;
    const handle = browserFleetPollEnvironment.setInterval(() => (fired += 1), 60_000);
    browserFleetPollEnvironment.clearInterval(handle);
    let seen = 0;
    const release = browserFleetPollEnvironment.onVisibility(() => (seen += 1));
    document.dispatchEvent(new Event('visibilitychange'));
    release();
    document.dispatchEvent(new Event('visibilitychange'));
    expect(seen).toBe(1);
    expect(fired).toBe(0);
  });
});

/** Feed timers the test moves by hand. */
const feedTime = () => {
  let time = 0;
  let next = 0;
  const timers: { id: number; at: number; run: () => void }[] = [];
  const environment: FleetFeedEnvironment = {
    setTimeout: (run, milliseconds) => {
      next += 1;
      timers.push({ id: next, at: time + milliseconds, run });
      return next;
    },
    clearTimeout: handle => {
      const index = timers.findIndex(timer => timer.id === handle);
      if (index >= 0) timers.splice(index, 1);
    },
    now: () => time,
    random: () => 0,
  };
  return {
    environment,
    advance: async (milliseconds: number) => {
      const until = time + milliseconds;
      for (;;) {
        const due = timers.filter(timer => timer.at <= until).sort((left, right) => left.at - right.at)[0];
        if (due === undefined) break;
        timers.splice(timers.indexOf(due), 1);
        time = due.at;
        await interact(() => due.run());
      }
      time = until;
    },
  };
};

/** Each machine's fleet feed, held open for the test to speak for its daemon. */
const feeds = () => {
  const opened = new Map<
    string,
    { idle: () => void; event: () => void; fail: (reason: unknown) => void; signal: AbortSignal }
  >();
  const open: MachineFleetFeedOpener = (machine, onEvent, onIdle, signal) =>
    new Promise<void>((_resolve, reject) => {
      opened.set(String(machine.daemonId), {
        idle: () => onIdle(30),
        event: () =>
          onEvent({
            sequence: 1,
            time: '2026-10-22T00:00:00.000Z',
            sessionId: 's',
            type: 'turn.state',
            source: 'daemon',
            data: {},
          } as never),
        fail: reject,
        signal,
      });
    });
  return { opened, open };
};

describe('useMachinesPoll with fleet feeds', () => {
  test('every event a machine’s feed delivers is handed on with the machine it came from', async () => {
    // Arrange
    const { fleet } = recorder();
    const fake = fakeEnvironment();
    const time = feedTime();
    const daemons = feeds();
    const heard: string[] = [];
    view = await mount(
      <Poller
        current={alpha.daemonId}
        environment={fake.environment}
        feedEnvironment={time.environment}
        fleet={fleet}
        machines={[alpha, beta]}
        onFeedEvent={(daemonId, event) => heard.push(`${String(daemonId)}:${event.type}`)}
        openFleetFeed={daemons.open}
      />,
    );

    // Act
    await interact(() => daemons.opened.get('beta')?.event());
    await interact(() => daemons.opened.get('alpha')?.event());

    // Assert
    expect(heard).toEqual(['beta:turn.state', 'alpha:turn.state']);
  });

  test('a machine whose feed is live is read on its word, and on the beat only as a safety net', async () => {
    // Arrange — alpha's daemon has the feed; beta's is too old for it.
    const { reads, fleet } = recorder();
    const fake = fakeEnvironment();
    const time = feedTime();
    const daemons = feeds();
    view = await mount(
      <Poller
        current={alpha.daemonId}
        environment={fake.environment}
        fleet={fleet}
        machines={[alpha, beta]}
        openFleetFeed={daemons.open}
        feedEnvironment={time.environment}
      />,
    );
    await interact(async () => {
      daemons.opened.get('alpha')?.idle();
      daemons.opened.get('beta')?.fail(Object.assign(new Error('unknown parameter tail'), { status: 400 }));
      await Promise.resolve();
    });
    const opening = reads.length;

    // Act — both beats fire: alpha's is skipped while its feed is live, beta's reads as it always did.
    fake.tick(FLEET_POLL_MS);
    fake.tick(BACKGROUND_POLL_MS);
    const afterBeats = reads.map(read => String(read.daemonId)).slice(opening);
    // Alpha's daemon says something moved.
    await interact(() => daemons.opened.get('alpha')?.event());
    await time.advance(FLEET_FEED_SETTLE_MS);
    const afterEvent = reads.map(read => String(read.daemonId)).slice(opening);
    // Long enough without a read, the beat reads alpha once more as a safety net.
    fake.setTime(FLEET_FEED_SAFETY_MS);
    fake.tick(FLEET_POLL_MS);
    const afterSafety = reads.length;
    // Hidden, an event reads nothing.
    fake.hide();
    await interact(() => daemons.opened.get('alpha')?.event());
    await time.advance(5_000);

    // Assert
    expect(opening).toBe(2);
    expect(afterBeats).toEqual(['beta']);
    expect(afterEvent).toEqual(['beta', 'alpha']);
    expect(afterSafety).toBe(opening + 3);
    expect(reads.length).toBe(afterSafety);
    await view.unmount();
    view = null;
    expect(daemons.opened.get('alpha')?.signal.aborted).toBe(true);
  });

  test('a feed reads through the connection the pairing has now, without reopening', async () => {
    // Arrange
    const { reads, fleet } = recorder();
    const fake = fakeEnvironment();
    const time = feedTime();
    const daemons = feeds();
    const fresh = daemonConnection({
      daemonId: 'alpha',
      baseUrl: 'https://alpha.example.test',
      deviceId: 'alpha-device',
    });
    view = await mount(
      <Poller
        current={null}
        environment={fake.environment}
        fleet={fleet}
        machines={[alpha]}
        openFleetFeed={daemons.open}
        feedEnvironment={time.environment}
      />,
    );
    const feed = daemons.opened.get('alpha');

    // Act — the same pairing republished as a new object, then an event.
    await view.render(
      <Poller
        current={null}
        environment={fake.environment}
        fleet={fleet}
        machines={[fresh]}
        openFleetFeed={daemons.open}
        feedEnvironment={time.environment}
      />,
    );
    await interact(() => feed?.event());
    await time.advance(FLEET_FEED_SETTLE_MS);

    // Assert — the feed was not reopened, and its read went through the new object.
    expect(daemons.opened.get('alpha')).toBe(feed);
    expect(reads.at(-1)).toBe(fresh);
  });
});
