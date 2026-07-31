import { describe, it } from 'bun:test';
import { BrowserLoginStatusSchema } from '@ferretry/protocol';
import should from 'should';
import {
  BrowserControlError,
  type BrowserLoginStatus,
  type BrowserProfileLease,
  type BrowserProfilePort,
} from '../../../../src/lib/index.ts';
import {
  BrowserLoginWindowService,
  type BrowserLoginChild,
  type BrowserLoginRuntime,
} from '../../../../src/adapters/index.ts';

/**
 * Every status the daemon emits must satisfy the wire contract the reader parses
 * with, so each one is put through the protocol schema on the way to its
 * assertions: a field written in a state that never produces it fails here
 * rather than in a browser.
 */
function onTheWire(status: BrowserLoginStatus): BrowserLoginStatus {
  return BrowserLoginStatusSchema.parse(status);
}

/** Narrows to the open member so its connection can be asserted. */
function openWindow(status: BrowserLoginStatus): Extract<BrowserLoginStatus, { state: 'open' }> {
  if (status.state !== 'open') throw new Error(`expected an open window, got ${status.state}`);
  return status;
}

interface Pause {
  /** Resolves once the runtime step has been reached. */
  readonly hit: Promise<void>;
  /** What the runtime step awaits: it announces its arrival, then blocks. */
  readonly block: () => Promise<void>;
  readonly release: () => void;
}

/**
 * A one-shot pause inside a runtime step, so a test can observe the transient
 * `opening` and `closing` states from the outside while the service is still
 * inside `start`/`stop`. `status()` is deliberately not queued behind the
 * lifecycle, which is exactly what makes those states observable.
 */
function pause(): Pause {
  const box: { arrive: () => void; release: () => void } = { arrive: () => undefined, release: () => undefined };
  const hit = new Promise<void>(resolve => {
    box.arrive = resolve;
  });
  const held = new Promise<void>(resolve => {
    box.release = resolve;
  });
  return {
    hit,
    block: async () => {
      box.arrive();
      await held;
    },
    release: () => box.release(),
  };
}

class FakeProfile implements BrowserProfilePort {
  readonly calls: string[] = [];
  primed = false;
  readonly lease: BrowserProfileLease = {
    profile: '/private/profile',
    sessionId: 'human-login',
    daemonPid: 101,
    acquiredAt: new Date(0).toISOString(),
    recoveredDeadOwner: false,
    updateChromePid: async pid => {
      this.calls.push(`pid:${pid ?? 'none'}`);
    },
    cleanupStaleChromeLocks: async () => [],
    markPrimed: async () => {
      this.calls.push('primed');
      this.primed = true;
    },
    release: async () => {
      this.calls.push('release');
      return true;
    },
  };

  async acquire(): Promise<BrowserProfileLease> {
    this.calls.push('acquire');
    return this.lease;
  }

  async isPrimed(): Promise<boolean> {
    return this.primed;
  }

  async assertChromeVersionCompatible(): Promise<void> {
    this.calls.push('version');
  }
}

function child(pid: number): BrowserLoginChild {
  return { pid, exited: new Promise(() => undefined), kill: () => undefined };
}

function runtime(
  events: string[],
  platform: NodeJS.Platform = 'linux',
  failVnc = false,
  holds: { readonly openingChrome?: Pause; readonly closingVnc?: Pause } = {},
): BrowserLoginRuntime {
  return {
    platform,
    environmentSource: { PATH: '/bin', FY_TOKEN: 'secret' },
    hostname: 'host',
    sshUser: 'person',
    display: async () => ':99',
    chromeExecutable: () => '/chrome',
    x11vncExecutable: () => '/x11vnc',
    timeoutExecutable: () => '/timeout',
    chromeVersion: async () => 'Chrome 150.0.0.0',
    spawn: argv => {
      events.push(argv.join(' '));
      return child(events.length === 1 ? 200 : 300);
    },
    freePort: async () => 5901,
    writePassword: async password => {
      events.push(`password:${password}`);
      return '/run/password';
    },
    waitForChrome: async () => {
      if (holds.openingChrome !== undefined) await holds.openingChrome.block();
      events.push('chrome-ready');
    },
    waitForVnc: async () => {
      if (failVnc) throw new Error('VNC did not bind');
      events.push('vnc-ready');
    },
    removePassword: async file => {
      events.push(`remove:${file}`);
    },
    terminateChrome: async () => {
      events.push('terminate:chrome');
    },
    terminateVnc: async () => {
      if (holds.closingVnc !== undefined) await holds.closingVnc.block();
      events.push('terminate:vnc');
    },
    now: () => 0,
  };
}

describe('BrowserLoginWindowService', () => {
  it('should create a loopback-only human login window and close exposure before Chrome', async () => {
    // Arrange
    const events: string[] = [];
    const profile = new FakeProfile();
    const subject = new BrowserLoginWindowService({
      profile,
      runtime: runtime(events),
      closeAgentBrowsers: async () => {
        events.push('agents-closed');
      },
      password: () => 'abcdefgh',
    });

    // Act
    const opened = openWindow(onTheWire(await subject.start({ minutes: 2 })));
    const confirmed = onTheWire(await subject.confirm());
    const closed = onTheWire(await subject.stop({ primed: true }));

    // Assert
    should(opened).match({ state: 'open', profilePrimed: false, openedAt: new Date(0).toISOString() });
    should(opened.connection).match({
      host: '127.0.0.1',
      port: 5901,
      password: 'abcdefgh',
      sshTunnel: 'ssh -N -L 5901:127.0.0.1:5901 person@host',
    });
    should(events[1]).containEql('--user-data-dir=/private/profile');
    should(events[1]).not.containEql('--remote-debugging');
    should(events[4]).containEql('-listen 127.0.0.1 -localhost -noipv6');
    should(events[4]).containEql('--signal=TERM');
    should(confirmed.profilePrimed).be.true();
    should(closed).deepEqual({ state: 'closed', profilePrimed: true });
    should(events.slice(-3)).deepEqual(['terminate:vnc', 'terminate:chrome', 'remove:/run/password']);
    should(profile.calls).deepEqual(['acquire', 'version', 'pid:300', 'primed', 'primed', 'pid:none', 'release']);
  });

  it('should refuse non-Linux login and accurately tear down a failed opening', async () => {
    // Arrange
    const events: string[] = [];
    const profile = new FakeProfile();
    const failedRuntime = runtime(events, 'linux', true);
    const failed = new BrowserLoginWindowService({ profile, runtime: failedRuntime, password: () => 'abcdefgh' });
    const unsupported = new BrowserLoginWindowService({ profile: new FakeProfile(), runtime: runtime([], 'darwin') });

    // Act + Assert
    await should(unsupported.start()).be.rejectedWith(BrowserControlError);
    await should(failed.start()).be.rejectedWith(BrowserControlError);
    const errored = onTheWire(await failed.status());
    should(errored).match({
      state: 'error',
      profilePrimed: false,
      error: /^the human browser login window could not/u,
    });
    // A failure reports the failure and nothing else: no torn-down endpoint and
    // no countdown for a window that never opened.
    should(errored).not.have.properties('connection', 'openedAt', 'expiresAt');
    // A platform that cannot host the window never entered a lifecycle at all,
    // so it reports closed rather than a failure it did not have.
    should(onTheWire(await unsupported.status())).deepEqual({ state: 'closed', profilePrimed: false });
    should(events.slice(-3)).deepEqual(['terminate:vnc', 'terminate:chrome', 'remove:/run/password']);
    should(profile.calls.slice(-2)).deepEqual(['pid:none', 'release']);
    await should(failed.confirm()).be.rejectedWith(BrowserControlError);
  });

  it('should report opening and closing on the wire while the window is still coming up or tearing down', async () => {
    // Arrange
    const events: string[] = [];
    const profile = new FakeProfile();
    const openingChrome = pause();
    const closingVnc = pause();
    const subject = new BrowserLoginWindowService({
      profile,
      runtime: runtime(events, 'linux', false, { openingChrome, closingVnc }),
      password: () => 'abcdefgh',
    });

    // Act + Assert: a window on its way up has no endpoint and no countdown yet.
    const starting = subject.start({ minutes: 2 });
    await openingChrome.hit;
    should(onTheWire(await subject.status())).deepEqual({ state: 'opening', profilePrimed: false });
    openingChrome.release();
    const opened = openWindow(onTheWire(await starting));

    // Act + Assert: tearing down keeps the lifecycle instants and drops the
    // credential the moment the window stops being usable.
    const stopping = subject.stop();
    await closingVnc.hit;
    const closing = onTheWire(await subject.status());
    should(closing).deepEqual({
      state: 'closing',
      profilePrimed: false,
      openedAt: opened.openedAt,
      expiresAt: opened.expiresAt,
    });
    should(closing).not.have.property('connection');
    closingVnc.release();
    should(onTheWire(await stopping)).deepEqual({ state: 'closed', profilePrimed: false });
  });
});
