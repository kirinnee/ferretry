import { readFile } from 'node:fs/promises';
import { commandLabel, type PathRoots, pathShape } from '@ferretry/protocol';
import type { ProcessGaugePort, ProcessReading } from '../../lib/performance/profiler.ts';
import type { PerformanceProbe } from '../../lib/performance/recorder.ts';
import type { MillisecondClockPort } from '../../lib/runtime/boot.ts';
import { memoryUsage } from './memory-usage.ts';

/**
 * The instruments a performance profile reads, at the edges only the runtime can see.
 *
 * - {@link ProcessGauges} — the process's own CPU, memory and context switches, and on Linux its read
 *   and write system calls and its reaped children's CPU, from `/proc/self`.
 * - {@link instrumentChildProcesses} — every child the daemon starts, by program and subcommand.
 * - {@link countedFileOperations} — every call on one of the daemon's own file ports, by path shape.
 */

/** Clock ticks per second in `/proc/<pid>/stat`: 100 on every Linux the daemon ships for. */
const CLOCK_TICKS_PER_SECOND = 100;

export class ProcessGauges implements ProcessGaugePort {
  constructor(
    private readonly platform: string = process.platform,
    private readonly readProc: (path: string) => Promise<string> = async path => await readFile(path, 'utf8'),
  ) {}

  async read(): Promise<ProcessReading> {
    const cpu = process.cpuUsage();
    const memory = memoryUsage();
    const usage = process.resourceUsage();
    const linux = this.platform === 'linux' ? await this.#linux() : {};
    return {
      cpuUserMicros: cpu.user,
      cpuSystemMicros: cpu.system,
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      externalBytes: memory.external,
      voluntaryContextSwitches: usage.voluntaryContextSwitches,
      involuntaryContextSwitches: usage.involuntaryContextSwitches,
      ...linux,
    };
  }

  async #linux(): Promise<Pick<ProcessReading, 'syscalls' | 'childrenCpuMs'>> {
    const [io, stat] = await Promise.all([
      this.readProc('/proc/self/io').catch(() => undefined),
      this.readProc('/proc/self/stat').catch(() => undefined),
    ]);
    const syscalls = io === undefined ? undefined : procIoSyscalls(io);
    const childrenCpuMs = stat === undefined ? undefined : procStatChildrenCpuMs(stat);
    return {
      ...(syscalls === undefined ? {} : { syscalls }),
      ...(childrenCpuMs === undefined ? {} : { childrenCpuMs }),
    };
  }
}

/** `syscr` and `syscw` from `/proc/<pid>/io`; `undefined` when either is missing. */
export function procIoSyscalls(text: string): { reads: number; writes: number } | undefined {
  const field = (name: string): number | undefined => {
    const match = new RegExp(`^${name}:\\s*(\\d+)`, 'mu').exec(text);
    return match?.[1] === undefined ? undefined : Number(match[1]);
  };
  const reads = field('syscr');
  const writes = field('syscw');
  return reads === undefined || writes === undefined ? undefined : { reads, writes };
}

/**
 * `cutime + cstime` from `/proc/<pid>/stat`, in milliseconds: the CPU every child this process reaped
 * spent. The command name in field 2 may hold spaces and parentheses, so fields count from the LAST `)`.
 */
export function procStatChildrenCpuMs(text: string): number | undefined {
  const close = text.lastIndexOf(')');
  if (close < 0) return undefined;
  // After `) `: state is field 3, so cutime (16) and cstime (17) are at offsets 13 and 14.
  const fields = text
    .slice(close + 2)
    .trim()
    .split(/\s+/u);
  const cutime = Number(fields[13]);
  const cstime = Number(fields[14]);
  if (!Number.isFinite(cutime) || !Number.isFinite(cstime)) return undefined;
  return ((cutime + cstime) * 1_000) / CLOCK_TICKS_PER_SECOND;
}

type SpawnArguments = Parameters<typeof Bun.spawn>;
type SpawnSyncArguments = Parameters<typeof Bun.spawnSync>;

/** The command line of a `Bun.spawn`/`Bun.spawnSync` call, whichever of its two shapes it used. */
export function spawnedArgv(first: unknown): readonly string[] {
  if (Array.isArray(first)) return first.map(String);
  const cmd = (first as { cmd?: unknown } | undefined)?.cmd;
  return Array.isArray(cmd) ? cmd.map(String) : [];
}

/** The runtime's two process starters, as the instrument replaces them. */
export interface SpawnHost {
  spawn: typeof Bun.spawn;
  spawnSync: typeof Bun.spawnSync;
}

/**
 * Counts every child process this daemon starts, by program and subcommand, and how long each ran.
 *
 * EVERY child in Bun goes through `Bun.spawn` or `Bun.spawnSync` — `node:child_process` included — so
 * replacing those two counts all of them, from any package, without a single call site knowing. The
 * replacement only describes a child while a profile is recording; otherwise it is one property read
 * and a direct call. Returns the function that puts the originals back.
 */
export function instrumentChildProcesses(
  probe: PerformanceProbe,
  clock: MillisecondClockPort,
  host: SpawnHost = Bun,
  /** The labelled work running right now, so each child is attributed to the timer that started it. */
  activity: () => string | undefined = () => undefined,
): () => void {
  const spawn = host.spawn;
  const spawnSync = host.spawnSync;
  const counted = ((...args: SpawnArguments) => {
    const child = spawn(...args);
    if (!probe.recording) return child;
    const command = commandLabel(spawnedArgv(args[0]));
    const startedAt = clock.now();
    probe.childStarted(command, false, activity());
    void child.exited.then(
      () => probe.childExited(command, clock.now() - startedAt),
      () => undefined,
    );
    return child;
  }) as typeof Bun.spawn;
  const countedSync = ((...args: SpawnSyncArguments) => {
    if (!probe.recording) return spawnSync(...args);
    const command = commandLabel(spawnedArgv(args[0]));
    const startedAt = clock.now();
    probe.childStarted(command, true, activity());
    try {
      return spawnSync(...args);
    } finally {
      probe.childExited(command, clock.now() - startedAt);
    }
  }) as typeof Bun.spawnSync;
  host.spawn = counted;
  host.spawnSync = countedSync;
  return () => {
    if (host.spawn === counted) host.spawn = spawn;
    if (host.spawnSync === countedSync) host.spawnSync = spawnSync;
  };
}

/**
 * `port`, with every method call that names a path counted into the probe as `<name>.<method>` on that
 * path's shape, timed until it settles.
 *
 * A PROXY, so every method passes through — including ones the port grows later — and `this` inside a
 * method is still the port itself, which its private fields need. A call whose first argument is not a
 * path, or any call while nothing records, is passed straight through and costs a property read.
 */
export function countedFileOperations<T extends object>(
  port: T,
  name: string,
  probe: PerformanceProbe,
  clock: MillisecondClockPort,
  roots: PathRoots,
): T {
  const wrapped = new Map<PropertyKey, unknown>();
  return new Proxy(port, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      const cached = wrapped.get(property);
      if (cached !== undefined) return cached;
      const method = value as (...args: unknown[]) => unknown;
      const operation = `${name}.${String(property)}`;
      const instrumented = (...args: unknown[]): unknown => {
        const path = args[0];
        if (!probe.recording || typeof path !== 'string') return method.apply(target, args);
        const startedAt = clock.now();
        const record = (): void => probe.fileOperation(operation, pathShape(path, roots), clock.now() - startedAt);
        let result: unknown;
        try {
          result = method.apply(target, args);
        } catch (error) {
          record();
          throw error;
        }
        if (result instanceof Promise) return result.finally(record);
        record();
        return result;
      };
      wrapped.set(property, instrumented);
      return instrumented;
    },
  });
}
