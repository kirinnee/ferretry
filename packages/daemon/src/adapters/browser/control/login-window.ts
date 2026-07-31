import {
  BrowserControlError,
  browserEnvironment,
  browserLoginChromeArguments,
  generateVncPassword,
  loginWindowMinutes,
  vncSupervisorArguments,
  x11vncLaunchArguments,
  type BrowserLoginLifecycle,
  type BrowserLoginStatus,
  type BrowserLoginWindow,
  type BrowserProfilePort,
} from '../../../lib/browser/control/index.ts';

export interface BrowserLoginChild {
  readonly pid: number;
  readonly exited: Promise<number>;
  kill(signal: NodeJS.Signals): void;
}

/** All process, clock, display and secret-file effects needed by the login window. */
export interface BrowserLoginRuntime {
  readonly platform: NodeJS.Platform;
  readonly environmentSource: Readonly<Record<string, string | undefined>>;
  readonly hostname: string;
  readonly sshUser: string;
  display(): Promise<string>;
  chromeExecutable(): string;
  x11vncExecutable(): string;
  timeoutExecutable(): string;
  chromeVersion(executable: string): Promise<string>;
  spawn(argv: readonly string[], environment: Readonly<Record<string, string | undefined>>): BrowserLoginChild;
  freePort(): Promise<number>;
  writePassword(password: string): Promise<string>;
  waitForChrome(profile: string, child: BrowserLoginChild): Promise<void>;
  waitForVnc(port: number, child: BrowserLoginChild): Promise<void>;
  removePassword(file: string): Promise<void>;
  terminateChrome(child: BrowserLoginChild): Promise<void>;
  terminateVnc(child: BrowserLoginChild): Promise<void>;
  now(): number;
}

export interface BrowserLoginWindowOptions {
  readonly profile: BrowserProfilePort;
  readonly runtime: BrowserLoginRuntime;
  readonly closeAgentBrowsers?: () => Promise<void>;
  readonly password?: () => string;
}

interface ActiveWindow extends BrowserLoginWindow {
  readonly chrome: BrowserLoginChild;
  readonly vnc: BrowserLoginChild;
  readonly passwordFile: string;
}

type MutableLoginStatus = { -readonly [Key in keyof BrowserLoginStatus]: BrowserLoginStatus[Key] };

/**
 * Coordinates a direct-child Chrome and a supervised, loopback-only VNC server.
 * Runtime state is deliberately adapter-local: no credential or window record is
 * written to durable state.
 */
export class BrowserLoginWindowService implements BrowserLoginLifecycle {
  private state: BrowserLoginStatus['state'] = 'closed';
  private active: ActiveWindow | undefined;
  private failure: string | undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly options: BrowserLoginWindowOptions) {}

  async status(): Promise<BrowserLoginStatus> {
    const status: MutableLoginStatus = { state: this.state, profilePrimed: await this.profilePrimed() };
    if (this.active && (this.state === 'open' || this.state === 'closing')) {
      const { openedAt, expiresAt, port, password } = this.active;
      Object.assign(status, { openedAt, expiresAt });
      if (this.state === 'open') {
        status.connection = {
          host: '127.0.0.1',
          port,
          password,
          sshTunnel: `ssh -N -L ${port}:127.0.0.1:${port} ${this.options.runtime.sshUser}@${this.options.runtime.hostname}`,
        };
      }
    }
    if (this.state === 'error' && this.failure) status.error = this.failure;
    return status;
  }

  async start(options: { readonly minutes?: number } = {}): Promise<BrowserLoginStatus> {
    const minutes = loginWindowMinutes(options.minutes);
    return await this.serial(async () => {
      if (this.state === 'open') return await this.status();
      if (this.options.runtime.platform !== 'linux') {
        throw new BrowserControlError('launch_failed', 'the human browser login window is available only on Linux');
      }
      return await this.open(minutes);
    });
  }

  async stop(options: { readonly primed?: boolean } = {}): Promise<BrowserLoginStatus> {
    return await this.serial(async () => {
      if (this.active) await this.close(options.primed === true);
      else {
        this.state = 'closed';
        this.failure = undefined;
      }
      return await this.status();
    });
  }

  async confirm(): Promise<BrowserLoginStatus> {
    return await this.serial(async () => {
      if (!this.active || this.state !== 'open') {
        throw new BrowserControlError('launch_failed', 'the human browser login window is not open');
      }
      await this.active.lease.markPrimed(this.active.chromeVersion);
      return await this.status();
    });
  }

  private get profile(): BrowserProfilePort {
    return this.options.profile;
  }

  private async open(minutes: number): Promise<BrowserLoginStatus> {
    this.state = 'opening';
    this.failure = undefined;
    let lease: Awaited<ReturnType<BrowserProfilePort['acquire']>> | undefined;
    let chrome: BrowserLoginChild | undefined;
    let vnc: BrowserLoginChild | undefined;
    let passwordFile: string | undefined;
    try {
      await this.options.closeAgentBrowsers?.();
      const runtime = this.options.runtime;
      const chromeExecutable = runtime.chromeExecutable();
      const chromeVersion = await runtime.chromeVersion(chromeExecutable);
      lease = await this.profile.acquire({ sessionId: 'human-login', chromeVersion });
      await this.profile.assertChromeVersionCompatible(chromeVersion);
      await lease.cleanupStaleChromeLocks();
      const display = await runtime.display();
      chrome = runtime.spawn(
        browserLoginChromeArguments(chromeExecutable, lease.profile, runtime.platform),
        browserEnvironment(display, runtime.environmentSource),
      );
      await lease.updateChromePid(chrome.pid, chromeVersion);
      await runtime.waitForChrome(lease.profile, chrome);
      const port = await runtime.freePort();
      const password = this.options.password?.() ?? generateVncPassword(buffer => crypto.getRandomValues(buffer));
      passwordFile = await runtime.writePassword(password);
      const vncArgv = x11vncLaunchArguments(runtime.x11vncExecutable(), display, port, passwordFile, minutes * 60);
      vnc = runtime.spawn(
        vncSupervisorArguments(runtime.timeoutExecutable(), minutes * 60, vncArgv),
        browserEnvironment(display, runtime.environmentSource),
      );
      await runtime.waitForVnc(port, vnc);
      const openedAt = new Date(runtime.now()).toISOString();
      const expiresAt = new Date(runtime.now() + minutes * 60_000).toISOString();
      this.active = {
        chrome,
        vnc,
        lease,
        chromeVersion,
        port,
        password,
        passwordFile,
        openedAt,
        expiresAt,
        chromePid: chrome.pid,
        vncPid: vnc.pid,
      };
      this.state = 'open';
      return await this.status();
    } catch (error) {
      await this.teardown({ chrome, vnc, lease, passwordFile });
      this.active = undefined;
      this.state = 'error';
      this.failure = this.safeError(error);
      throw error instanceof BrowserControlError ? error : new BrowserControlError('launch_failed', this.failure);
    }
  }

  private async close(primed: boolean): Promise<void> {
    const active = this.active;
    if (!active) return;
    this.state = 'closing';
    let markerError: unknown;
    if (primed) {
      try {
        await active.lease.markPrimed(active.chromeVersion);
      } catch (error) {
        markerError = error;
      }
    }
    await this.teardown(active);
    this.active = undefined;
    this.state = 'closed';
    this.failure = undefined;
    if (markerError) throw markerError;
  }

  private async teardown(parts: {
    readonly chrome?: BrowserLoginChild;
    readonly vnc?: BrowserLoginChild;
    readonly lease?: Awaited<ReturnType<BrowserProfilePort['acquire']>>;
    readonly passwordFile?: string;
  }): Promise<void> {
    if (parts.vnc) await this.options.runtime.terminateVnc(parts.vnc).catch(() => undefined);
    if (parts.chrome) await this.options.runtime.terminateChrome(parts.chrome).catch(() => undefined);
    if (parts.passwordFile) await this.options.runtime.removePassword(parts.passwordFile).catch(() => undefined);
    if (parts.lease) {
      await parts.lease.updateChromePid().catch(() => undefined);
      await parts.lease.release().catch(() => undefined);
    }
  }

  private async profilePrimed(): Promise<boolean> {
    try {
      return await this.profile.isPrimed();
    } catch {
      return false;
    }
  }

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const run = this.queue.then(action, action);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private safeError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return `the human browser login window could not open: ${message.split('\n', 1)[0]?.slice(0, 300) ?? 'unknown error'}`;
  }
}
