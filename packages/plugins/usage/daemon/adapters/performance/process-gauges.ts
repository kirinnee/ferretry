import type { SelfCountersPort } from '@ferretry/kernel/contract';
import type { ProcessReading } from '../../lib/performance/profiler.ts';

/** Clock ticks per second in `/proc/<pid>/stat`: 100 on every Linux the daemon ships for. */
const CLOCK_TICKS_PER_SECOND = 100;

/**
 * The process's own counters (`fy daemon profile`): CPU, memory and context switches from the runtime, and on Linux its
 * read and write system calls (`/proc/self/io`) and its reaped children's CPU (`/proc/self/stat`) through the kernel's
 * `selfCounters` port, which reads those two files of THIS process and nothing else. Everywhere else, or where a file
 * cannot be read, those two are simply absent: a report never invents them.
 */
export class ProcessGauges {
  constructor(private readonly counters: SelfCountersPort) {}

  async read(): Promise<ProcessReading> {
    const cpu = process.cpuUsage();
    const memory = process.memoryUsage();
    const usage = process.resourceUsage();
    const linux = this.counters.platform === 'linux' ? await this.#linux() : {};
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
      this.counters.io().catch(() => undefined),
      this.counters.stat().catch(() => undefined),
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
 * `cutime + cstime` from `/proc/<pid>/stat`, in milliseconds: the CPU every child this process reaped spent. The command
 * name in field 2 may hold spaces and parentheses, so fields count from the LAST `)`.
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
