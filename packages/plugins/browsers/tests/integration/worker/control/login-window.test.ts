import { describe, it } from 'bun:test';
import { BrowserLoginStatusSchema } from '../../../../contract/index.ts';
import should from 'should';
import { BrowserControlError } from '../../../../daemon/worker/control/policy.ts';
import type { BrowserLoginStatus } from '../../../../contract/index.ts';
import type { BrowserProfileLease, BrowserProfilePort } from '../../../../daemon/worker/control/profile.ts';
import {
  BrowserLoginWindowService,
  type BrowserLoginChild,
  type BrowserLoginRuntime,
} from '../../../../daemon/worker/control/adapters/login-window.ts';

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
    identity: 'agent',
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

/** A profile whose marker write fails, the way a full disk or a revoked lease would. */
class MarkerFailingProfile extends FakeProfile {
  override async acquire(): Promise<BrowserProfileLease> {
    const lease = await super.acquire();
    return {
      ...lease,
      markPrimed: async () => {
        this.calls.push('primed:failed');
        throw new Error('marker write failed');
      },
    };
  }
}

/** A profile whose primed check cannot be answered. */
class UnreadableProfile extends FakeProfile {
  override async isPrimed(): Promise<boolean> {
    throw new Error('profile directory unreadable');
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
    authority: () => '/state/x11/xauthority',
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
      configured: () => true,
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

  it("should hand the display's cookie file to both Chrome and x11vnc, and nothing of the host's own", async () => {
    // Arrange
    const environments: Readonly<Record<string, string | undefined>>[] = [];
    const base = runtime([]);
    const subject = new BrowserLoginWindowService({
      configured: () => true,
      profile: new FakeProfile(),
      runtime: {
        ...base,
        environmentSource: { PATH: '/bin', XAUTHORITY: '/home/operator/.Xauthority' },
        spawn: (argv, environment) => {
          environments.push(environment);
          return base.spawn(argv, environment);
        },
      },
      password: () => 'abcdefgh',
    });

    // Act
    await subject.start({ minutes: 2 });

    // Assert
    // Chrome, then the VNC supervisor: both are X clients, and the private display refuses a client without it.
    should(environments).have.length(2);
    for (const environment of environments) {
      should(environment).match({ DISPLAY: ':99', XAUTHORITY: '/state/x11/xauthority' });
    }
  });

  it('should refuse non-Linux login and accurately tear down a failed opening', async () => {
    // Arrange
    const events: string[] = [];
    const profile = new FakeProfile();
    const failedRuntime = runtime(events, 'linux', true);
    const failed = new BrowserLoginWindowService({
      configured: () => true,
      profile,
      runtime: failedRuntime,
      password: () => 'abcdefgh',
    });
    const unsupported = new BrowserLoginWindowService({
      configured: () => true,
      profile: new FakeProfile(),
      runtime: runtime([], 'darwin'),
    });

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
      configured: () => true,
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

  it('should return to closed and forget the failure when stopped after a failed opening', async () => {
    // Arrange
    const events: string[] = [];
    const subject = new BrowserLoginWindowService({
      configured: () => true,
      profile: new FakeProfile(),
      runtime: runtime(events, 'linux', true),
      password: () => 'abcdefgh',
    });
    await should(subject.start()).be.rejectedWith(BrowserControlError);
    should(onTheWire(await subject.status()).state).equal('error');

    // Act
    const stopped = onTheWire(await subject.stop());

    // Assert: nothing is running, so there is nothing to tear down a second time.
    should(stopped).deepEqual({ state: 'closed', profilePrimed: false });
    should(events.filter(event => event.startsWith('terminate:'))).have.length(2);
  });

  it('should still tear the window down and then report a failed primed marker', async () => {
    // Arrange
    const events: string[] = [];
    const profile = new MarkerFailingProfile();
    const subject = new BrowserLoginWindowService({
      configured: () => true,
      profile,
      runtime: runtime(events),
      password: () => 'abcdefgh',
    });
    await subject.start();

    // Act
    const stopping = subject.stop({ primed: true });

    // Assert: the marker error is the one the caller sees, but only after every process and the lease are gone.
    await should(stopping).be.rejectedWith('marker write failed');
    should(events.slice(-3)).deepEqual(['terminate:vnc', 'terminate:chrome', 'remove:/run/password']);
    should(profile.calls.slice(-3)).deepEqual(['primed:failed', 'pid:none', 'release']);
    should(onTheWire(await subject.status())).deepEqual({ state: 'closed', profilePrimed: false });
  });

  it('should report an unreadable profile as not primed instead of failing the status', async () => {
    // Arrange
    const subject = new BrowserLoginWindowService({
      configured: () => true,
      profile: new UnreadableProfile(),
      runtime: runtime([]),
    });

    // Act
    const status = onTheWire(await subject.status());

    // Assert
    should(status).deepEqual({ state: 'closed', profilePrimed: false });
  });
});

/** A profile store with one lease per identity, as the real one keeps: acquiring one identity twice is refused, two identities never clash. */
class IdentityProfiles implements BrowserProfilePort {
  readonly calls: string[] = [];
  readonly held = new Set<string>();
  readonly primed = new Set<string>();

  async acquire(identity: string): Promise<BrowserProfileLease> {
    if (this.held.has(identity)) throw new Error(`the ${identity} profile is already in use`);
    this.held.add(identity);
    this.calls.push(`acquire:${identity}`);
    return {
      identity,
      profile: `/private/data/${identity}`,
      sessionId: 'human-login',
      daemonPid: 101,
      acquiredAt: new Date(0).toISOString(),
      recoveredDeadOwner: false,
      updateChromePid: async () => undefined,
      cleanupStaleChromeLocks: async () => [],
      markPrimed: async () => {
        this.primed.add(identity);
      },
      release: async () => {
        this.held.delete(identity);
        this.calls.push(`release:${identity}`);
        return true;
      },
    };
  }

  async isPrimed(identity: string): Promise<boolean> {
    return this.primed.has(identity);
  }

  async assertChromeVersionCompatible(): Promise<void> {
    return undefined;
  }
}

/** The runtime of one machine with a screen per identity, recording which identity each step was for. */
function identityRuntime(events: string[]): BrowserLoginRuntime {
  let ports = 5900;
  let pids = 400;
  return {
    ...runtime([]),
    display: async identity => `:${identity ?? 'machine'}`,
    authority: identity => `/state/x11/${identity ?? 'machine'}`,
    releaseDisplay: async identity => {
      events.push(`screen-released:${identity}`);
    },
    spawn: argv => {
      events.push(`spawn:${argv.find(part => part.startsWith('--user-data-dir=')) ?? 'vnc'}`);
      pids += 1;
      return child(pids);
    },
    freePort: async () => {
      ports += 1;
      return ports;
    },
  };
}

describe('BrowserLoginWindowService, one window per identity', () => {
  it('should open the window for one identity and leave every other identity’s agent browser and window alone', async () => {
    // Arrange
    const events: string[] = [];
    const profiles = new IdentityProfiles();
    const subject = new BrowserLoginWindowService({
      configured: () => true,
      profile: profiles,
      runtime: identityRuntime(events),
      closeAgentBrowsers: async identity => {
        events.push(`agents-closed:${identity}`);
      },
      password: () => 'abcdefgh',
    });

    // Act
    const a = openWindow(onTheWire(await subject.start({ identity: 'a' })));
    const bBefore = onTheWire(await subject.status('b'));
    const b = openWindow(onTheWire(await subject.start({ identity: 'b' })));
    await subject.stop({ identity: 'a', primed: true });

    // Assert — only the named identity's browser was closed, each window has its own profile, screen and port
    should(events.filter(event => event.startsWith('agents-closed'))).deepEqual(['agents-closed:a', 'agents-closed:b']);
    should(events.filter(event => event.startsWith('spawn:--user-data-dir'))).deepEqual([
      'spawn:--user-data-dir=/private/data/a',
      'spawn:--user-data-dir=/private/data/b',
    ]);
    should(bBefore.state).equal('closed');
    should(a.connection.port).not.equal(b.connection.port);
    // Closing a released a's profile and screen and nothing of b's: b's window is still open and its lease still held.
    should(onTheWire(await subject.status('b')).state).equal('open');
    should(profiles.held.has('b')).equal(true);
    should(profiles.held.has('a')).equal(false);
    should(events).containEql('screen-released:a');
    should(events).not.containEql('screen-released:b');
    should(profiles.primed.has('a')).equal(true);
    should(profiles.primed.has('b')).equal(false);
  });

  it('should open the built-in agent identity’s window when none is named', async () => {
    // Arrange
    const events: string[] = [];
    const profiles = new IdentityProfiles();
    const subject = new BrowserLoginWindowService({
      configured: () => true,
      profile: profiles,
      runtime: identityRuntime(events),
      closeAgentBrowsers: async identity => {
        events.push(`agents-closed:${identity}`);
      },
    });

    // Act
    await subject.start();

    // Assert
    should(events).containEql('agents-closed:agent');
    should(profiles.held.has('agent')).equal(true);
  });

  it('should refuse a window for an identity the configuration does not name, even one whose profile is still on disk', async () => {
    // Arrange — `old` was retired from the configuration, but its profile folder (the fake profile store) still has it
    const events: string[] = [];
    const profiles = new IdentityProfiles();
    const subject = new BrowserLoginWindowService({
      configured: identity => identity === 'a',
      profile: profiles,
      runtime: identityRuntime(events),
      closeAgentBrowsers: async identity => {
        events.push(`agents-closed:${identity}`);
      },
    });

    // Act
    const refusals = await Promise.all(
      [
        async () => await subject.start({ identity: 'old' }),
        async () => await subject.status('old'),
        async () => await subject.confirm('old'),
        async () => await subject.stop({ identity: 'old' }),
      ].map(
        async call =>
          await call().then(
            () => undefined,
            (error: unknown) => error,
          ),
      ),
    );

    // Assert — each is a bad request in plain words, and nothing was closed, leased or spawned
    for (const refusal of refusals) {
      should(refusal).be.instanceOf(BrowserControlError);
      should(refusal).match({ code: 'bad_request' });
      should((refusal as Error).message).containEql('old');
    }
    should(events).deepEqual([]);
    should(profiles.held.size).equal(0);
    should(onTheWire(await subject.status('a')).state).equal('closed');
    should(onTheWire(await subject.status()).state).equal('closed');
  });
});

describe('BrowserLoginWindowService, an identity retired while the daemon runs', () => {
  it('should refuse every login operation for an identity retired after its window was first asked about, and spawn nothing', async () => {
    // Arrange — `a` is configured and its window service is made (a cached pass), then `a` is retired; its profile is still on disk
    const events: string[] = [];
    const profiles = new IdentityProfiles();
    const configured = new Set(['a']);
    const subject = new BrowserLoginWindowService({
      configured: identity => configured.has(identity),
      profile: profiles,
      runtime: identityRuntime(events),
      closeAgentBrowsers: async identity => {
        events.push(`agents-closed:${identity}`);
      },
    });
    should(onTheWire(await subject.status('a')).state).equal('closed');
    configured.delete('a');

    // Act
    const refusals = await Promise.all(
      [
        async () => await subject.status('a'),
        async () => await subject.start({ identity: 'a' }),
        async () => await subject.confirm('a'),
      ].map(
        async call =>
          await call().then(
            () => undefined,
            (error: unknown) => error,
          ),
      ),
    );

    // Assert
    for (const refusal of refusals) {
      should(refusal).be.instanceOf(BrowserControlError);
      should(refusal).match({ code: 'bad_request' });
    }
    should(events).deepEqual([]);
    should(profiles.held.size).equal(0);
  });
});
