import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { UserSliceReader, UserSliceReading } from '../../lib/core/user-slice.ts';

/** Where systemd and the kernel publish what the doctor reads. Overridable so a test can use a temporary tree. */
export interface UserSlicePlaces {
  /** Exists only while systemd is the running init. */
  readonly systemd: string;
  /** The cgroup v2 mount. */
  readonly cgroups: string;
  /** One empty file per user with linger on. */
  readonly linger: string;
}

const DEFAULT_PLACES: UserSlicePlaces = {
  systemd: '/run/systemd/system',
  cgroups: '/sys/fs/cgroup',
  linger: '/var/lib/systemd/linger',
};

/** Plain file reads finish at once; this only stops a wedged mount from holding a doctor report. */
const DEFAULT_TIMEOUT_MS = 1_000;

const TIMED_OUT = Symbol('timed out');

/**
 * Reads this user's slice limits and linger with plain file reads — no `loginctl`, no `systemctl`, no root.
 *
 * `memory.max` and `pids.max` in the user's cgroup are world-readable, and linger is a file under
 * `/var/lib/systemd/linger`, so the cheapest robust read is the file, not a child process. A host without
 * systemd answers `undefined`; a file that is not there (cgroup v1, a controller the slice does not carry)
 * is an absent field, never "unlimited". The whole read is bounded and never throws.
 */
export class SystemdUserSliceReader implements UserSliceReader {
  constructor(
    private readonly who: { readonly uid: number; readonly user: string },
    private readonly places: UserSlicePlaces = DEFAULT_PLACES,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
    private readonly readText: (path: string) => Promise<string> = async path => await readFile(path, 'utf8'),
  ) {}

  async read(): Promise<UserSliceReading | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<typeof TIMED_OUT>(resolve => {
      timer = setTimeout(() => resolve(TIMED_OUT), this.timeoutMs);
    });
    try {
      const reading = await Promise.race([this.readNow(), timeout]);
      return reading === TIMED_OUT ? undefined : reading;
    } finally {
      clearTimeout(timer);
    }
  }

  private async readNow(): Promise<UserSliceReading | undefined> {
    if (!(await this.exists(this.places.systemd))) return undefined;
    const slice = join(this.places.cgroups, 'user.slice', `user-${this.who.uid}.slice`);
    const [memoryMax, tasksMax, linger] = await Promise.all([
      this.text(join(slice, 'memory.max')),
      this.text(join(slice, 'pids.max')),
      this.exists(join(this.places.linger, this.who.user)),
    ]);
    return {
      uid: this.who.uid,
      user: this.who.user,
      ...(memoryMax === undefined ? {} : { memoryMax }),
      ...(tasksMax === undefined ? {} : { tasksMax }),
      linger,
    };
  }

  private async text(path: string): Promise<string | undefined> {
    try {
      const value = (await this.readText(path)).trim();
      return value === '' ? undefined : value;
    } catch {
      return undefined;
    }
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }
}
