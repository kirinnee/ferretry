/**
 * Where the owner's files are, read-only (today's `homedir()`). A name, never a capability: nothing here opens,
 * resolves or reaches a path; reaching one goes through a declared root.
 */
/** A per-process file under `/proc/<pid>/` (or `/proc/self/`) that `hostFacts.procFile` reads. */
export type ProcPidFile = 'stat' | 'status' | 'comm' | 'cmdline' | 'cgroup' | 'statm';

/** A machine-wide file under `/proc/` that `hostFacts.procSystemFile` reads. */
export type ProcSystemFile = 'stat' | 'meminfo' | 'sys/kernel/pid_max' | 'net/tcp' | 'net/tcp6';

/** A cgroup-v2 interface file under `/sys/fs/cgroup/<path>/` that `hostFacts.cgroupFile` reads. */
export type CgroupFile =
  | 'cgroup.controllers'
  | 'cgroup.procs'
  | 'memory.events'
  | 'memory.events.local'
  | 'memory.high'
  | 'memory.max'
  | 'memory.swap.max'
  | 'pids.max'
  | 'cpu.weight'
  | 'cpu.max';

/**
 * Whether a daemon a test booted must refuse to launch a real harness, and where it looks for one. The kernel decides
 * `active` ONCE at boot (`FERRETRY_TEST=1`, or the home's real path under `os.tmpdir()`, `/tmp` or `/var/folders`)
 * and hands the daemon's `PATH`; no plugin reads the environment.
 */
export interface HostLaunchGuard {
  readonly active: boolean;
  /** The daemon's `PATH`; absent when it has none. */
  readonly searchPath?: string;
}

/**
 * The machine reads today's Terminals made through `node:fs` (its interim `adapters/host/fs.ts`), as narrow methods
 * that each name one kind of file: a pid is a whole number, a descriptor is digits, a cgroup path is plain segments,
 * and no method takes a free path. Each throws as the read it replaces did (a vanished process, a missing file), so
 * a caller keeps its own catch.
 */
export interface HostFactsPort {
  /** `process.platform`. */
  readonly platform: string;
  /** `os.availableParallelism()`. */
  readonly cpus: number;
  /** `os.totalmem()`. */
  readonly totalMemoryBytes: number;
  /** The numeric entries of `/proc`. */
  pids(): Promise<readonly number[]>;
  procFile(pid: number | 'self', file: ProcPidFile): Promise<string>;
  procSystemFile(file: ProcSystemFile): Promise<string>;
  /** `readdir /proc/<pid>/task`. */
  procTasks(pid: number): Promise<readonly string[]>;
  /** `/proc/<pid>/task/<task>/children`. */
  procTaskChildren(pid: number, task: number): Promise<string>;
  /** `readdir /proc/<pid>/fd`. */
  procFds(pid: number): Promise<readonly string[]>;
  /** `readlink /proc/<pid>/fd/<fd>`. */
  procFdLink(pid: number, fd: string): Promise<string>;
  /** What `stat /proc/<pid>/fd/<fd>` reaches: whether a character device, and which (`rdev`). */
  procFdReach(pid: number, fd: string): Promise<{ readonly character: boolean; readonly device: number }>;
  /** `readlink /proc/<pid>/exe`. */
  procExecutable(pid: number): Promise<string>;
  /**
   * `readlink /proc/<pid>/cwd`: the folder the process works in NOW, as the one fact the move gate uses to classify a
   * `.mcp.json` server. Read-only and values-free (a path, no environment, no arguments). `undefined` when the
   * process is gone, is another user's, has a working folder that was removed, or the host has no procfs (darwin
   * always answers `undefined`). A pid that is not a whole number refuses like every other read. It is only a read:
   * the caller proves the pid is a descendant it already holds before asking; this method reads that one `cwd` link
   * and nothing else.
   */
  procWorkingDirectory(pid: number): Promise<string | undefined>;
  /** `/sys/fs/cgroup/<path>/<file>`; `path` is relative (`''` is the root). */
  cgroupFile(path: string, file: CgroupFile): Promise<string>;
  /** `readdir /sys/fs/cgroup/<path>`. */
  cgroupChildren(path: string): Promise<readonly string[]>;
  /**
   * A block device's I/O scheduler (`/sys/dev/block/<major>:<minor>`, resolved; a partition reads its parent
   * disk's `queue/scheduler`): the device's name and the file's text.
   */
  blockScheduler(major: number, minor: number): Promise<{ readonly device: string; readonly scheduler: string }>;
  /**
   * `statfs` of ONE absolute folder: the bytes a writer who is not the superuser could still put on the disk that
   * holds it. A free path by design, and the one fact it gives is a number: it opens, lists and reads nothing. `undefined`
   * when the folder is not there (a first install has no models folder yet) or the host cannot say.
   */
  diskFreeBytes(folder: string): Promise<number | undefined>;
  /** The launch-guard fact (see {@link HostLaunchGuard}); like every host fact, refused to a plugin without `permissions.hostFacts`. */
  launchGuard(): HostLaunchGuard;
}
