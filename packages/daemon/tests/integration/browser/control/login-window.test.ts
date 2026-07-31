import { describe, it } from 'bun:test';
import should from 'should';
import { BrowserControlError, type BrowserProfileLease, type BrowserProfilePort } from '../../../../src/lib/index.ts';
import {
  BrowserLoginWindowService,
  type BrowserLoginChild,
  type BrowserLoginRuntime,
} from '../../../../src/adapters/index.ts';

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

function runtime(events: string[], platform: NodeJS.Platform = 'linux', failVnc = false): BrowserLoginRuntime {
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
    const opened = await subject.start({ minutes: 2 });
    const confirmed = await subject.confirm();
    const closed = await subject.stop({ primed: true });

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
    should(await failed.status()).match({ state: 'error', profilePrimed: false });
    should(events.slice(-3)).deepEqual(['terminate:vnc', 'terminate:chrome', 'remove:/run/password']);
    should(profile.calls.slice(-2)).deepEqual(['pid:none', 'release']);
    await should(failed.confirm()).be.rejectedWith(BrowserControlError);
  });
});
