import type { BrowserPortsSetting, DoctorCheck } from '@ferretry/protocol';

/**
 * What the host says about THIS user's systemd slice and linger, as the doctor needs it. Every field is
 * absent when the host did not say: a non-systemd machine, a cgroup v1 host, or a controller the slice
 * does not carry give no answer, and no answer is never read as "unlimited".
 */
export interface UserSliceReading {
  readonly uid: number;
  readonly user: string;
  /** The slice's `memory.max`, as the kernel prints it (`max` is unlimited). */
  readonly memoryMax?: string;
  /** The slice's `pids.max`, as the kernel prints it (`max` is unlimited). */
  readonly tasksMax?: string;
  /** Whether `loginctl enable-linger` is on for this user. */
  readonly linger?: boolean;
}

/** The host's answer, or `undefined` where there is no systemd to ask. Never throws, never blocks long. */
export interface UserSliceReader {
  read(): Promise<UserSliceReading | undefined>;
}

/**
 * Reads this user's slice ONLY on a host that looks shared: Linux, with `browserPorts` set to anything but
 * `random` — the setting a person makes to share a machine (docs/multi-user-host.md step 8). A single-user
 * host is never asked, so it pays nothing and hears nothing. A setting that cannot be read is `random`.
 */
export async function readUserSlice(
  platform: NodeJS.Platform,
  setting: () => Promise<BrowserPortsSetting>,
  reader: UserSliceReader,
): Promise<UserSliceReading | undefined> {
  if (platform !== 'linux') return undefined;
  const wanted = await setting().catch(() => 'random' as const);
  if (wanted === 'random') return undefined;
  return await reader.read().catch(() => undefined);
}

/** The kernel prints `max` for no limit; systemd spells the same thing `infinity`. */
const limited = (value: string): boolean => value !== 'max' && value !== 'infinity';

const SLICE_CAPS = 'MemoryMax=12G TasksMax=4096 CPUWeight=100';

/**
 * THE SHARED-HOST ROWS, AS WARNINGS ONLY.
 *
 * `optional`, never `required`: a host without caps or linger still runs this daemon, so these rows say
 * what the guide recommends and can never make the report not ready. The fix is the guide's own command
 * (docs/multi-user-host.md steps 3 and 4), with this user's uid and name filled in; pick numbers that
 * suit the machine.
 *
 * A slice with only one of the two limits still warns, naming the one that is missing. A value the host
 * did not report adds no claim either way.
 */
export function userSliceChecks(reading: UserSliceReading | undefined): readonly DoctorCheck[] {
  if (reading === undefined) return [];
  const checks: DoctorCheck[] = [];
  const unbounded = [
    ...(reading.memoryMax !== undefined && !limited(reading.memoryMax) ? ['MemoryMax'] : []),
    ...(reading.tasksMax !== undefined && !limited(reading.tasksMax) ? ['TasksMax'] : []),
  ];
  if (unbounded.length > 0)
    checks.push({
      name: 'user slice limits',
      requirement: 'optional',
      status: 'missing',
      summary: `user-${reading.uid}.slice has no ${unbounded.join(' or ')}`,
      impact: `On a host shared by several users, one user's agents can starve the others of memory or processes. As an administrator: sudo systemctl set-property user-${reading.uid}.slice ${SLICE_CAPS}`,
    });
  else if (reading.memoryMax !== undefined || reading.tasksMax !== undefined)
    checks.push({
      name: 'user slice limits',
      requirement: 'optional',
      status: 'present',
      summary: `user-${reading.uid}.slice is capped`,
      impact: "One user's agents cannot take all of a shared host's memory or processes.",
    });
  if (reading.linger === false)
    checks.push({
      name: 'linger',
      requirement: 'optional',
      status: 'missing',
      summary: `linger is off for ${reading.user}`,
      impact: `On a shared host this daemon stops when ${reading.user} logs out, and its recorded port is free for anybody to take. As an administrator: sudo loginctl enable-linger ${reading.user}`,
    });
  else if (reading.linger === true)
    checks.push({
      name: 'linger',
      requirement: 'optional',
      status: 'present',
      summary: `linger is on for ${reading.user}`,
      impact: 'This daemon keeps running when its owner logs out.',
    });
  return checks;
}
