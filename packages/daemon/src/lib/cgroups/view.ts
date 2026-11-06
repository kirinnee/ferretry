/**
 * What is in force, in plain words: the one place the sentences are written.
 *
 * `fy daemon status`, the app's limits panel and the session view all print what this builds, so the
 * words are decided once. No cgroup jargon reaches a person: "soft" and "hard" memory limits, "slowed"
 * and "killed", "disk priority", never `MemoryHigh` or `oom_kill`.
 *
 * Pure: no IO, no clock, no globals.
 */
import {
  DAEMON_CPU_WEIGHT,
  GIBIBYTE,
  type LimitsConfig,
  type LimitsDiskEffect,
  type LimitsView,
  resolveLimits,
  VOICE_CPU_WEIGHT,
} from '@ferretry/protocol';
import type { EnforcementState } from './enforcement.ts';
import { ownerStep } from './owner-step.ts';
import type { CgroupHostFacts, DiskSchedulerReading } from './ports.ts';
import type { MemoryWatchState } from './watch.ts';

/** `40.8 GiB`, `48 GiB`, `512 MiB`. */
export function formatBytes(bytes: number): string {
  if (bytes >= GIBIBYTE) {
    const gib = Math.round((bytes / GIBIBYTE) * 10) / 10;
    return `${Number.isInteger(gib) ? gib.toFixed(0) : gib.toFixed(1)} GiB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MiB`;
}

/**
 * Whether disk priority can do anything on a disk, from its scheduler: BFQ honours the priority fully,
 * mq-deadline only by class, and `none` (most NVMe) and kyber not at all.
 */
export function diskEffect(scheduler: string | undefined): LimitsDiskEffect {
  switch (scheduler) {
    case 'bfq':
      return 'full';
    case 'mq-deadline':
    case 'deadline':
      return 'class-only';
    case 'none':
    case 'noop':
    case 'kyber':
      return 'none';
    default:
      return 'unknown';
  }
}

export interface LimitsViewInput {
  readonly config: LimitsConfig;
  readonly host: CgroupHostFacts;
  /** `undefined` before the first probe. */
  readonly enforcement: EnforcementState | undefined;
  /** The latest launch that could not be limited, if no later one could. */
  readonly launchFailure?: string;
  readonly disk: DiskSchedulerReading;
  readonly live: MemoryWatchState;
  readonly file: string;
  /** This user's id, for the one-time owner step. */
  readonly uid: number;
  /** Warnings from reading the machine (the daemon sitting inside the fleet slice, …). */
  readonly warnings: readonly string[];
  /** `2026-11-05T23:04:00Z` → `23:04`, in the machine’s own time. */
  readonly clock: (iso: string) => string;
}

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

const bytesOrNone = (bytes: number | null): number | null => bytes;

export function buildLimitsView(input: LimitsViewInput): LimitsView {
  const { host, enforcement } = input;
  const resolved = resolveLimits(input.config, { memoryCeilingBytes: host.memoryCeilingBytes });
  const explicit = input.config.enabled === true;
  const effect = host.platform === 'linux' ? diskEffect(input.disk.scheduler) : 'unknown';
  let kind: LimitsView['enforcement'] = 'none';
  let because: string | undefined;
  if (!resolved.enabled) because = `limits are switched off in ${input.file}`;
  else if (enforcement === undefined) because = 'the machine has not been checked yet';
  else if (enforcement.kind === 'direct') because = enforcement.reason;
  else if (enforcement.kind === 'priority') {
    kind = enforcement.wrapper === 'none' ? 'none' : 'priority';
    if (enforcement.wrapper === 'none') because = 'this Mac has neither taskpolicy nor nice';
  } else if (input.launchFailure !== undefined)
    because = `the last ferret could not be limited (${input.launchFailure})`;
  else kind = 'cgroups';

  const lines: string[] = [];
  const memory = (bytes: number | null): string => (bytes === null ? 'no limit' : formatBytes(bytes));
  const ionice =
    resolved.ionice && (enforcement?.kind === 'cgroups' || enforcement?.kind === 'direct') && enforcement.ionice;
  const diskText = !resolved.ionice
    ? 'switched off'
    : !ionice
      ? 'not available on this machine (no ionice)'
      : effect === 'full'
        ? `ferrets read and write at the lowest priority (scheduler ${input.disk.scheduler})`
        : effect === 'class-only'
          ? `works by class only (scheduler ${input.disk.scheduler})`
          : effect === 'none'
            ? `no effect on this disk (scheduler ${input.disk.scheduler})`
            : 'cannot tell whether it takes effect on this disk';
  if (kind === 'cgroups') {
    lines.push(
      `ferrets: memory ${memory(resolved.fleet.memoryHigh)} soft / ${memory(resolved.fleet.memoryMax)} hard of a ${formatBytes(host.memoryCeilingBytes)} user budget · CPU weight ${resolved.fleet.cpuWeight} (daemon ${DAEMON_CPU_WEIGHT}, voice ${VOICE_CPU_WEIGHT}) · disk priority: ${diskText}`,
      `each ferret: memory ${memory(resolved.perFerret.memoryHigh)} soft / ${memory(resolved.perFerret.memoryMax)} hard · up to ${resolved.perFerret.tasksMax ?? 'any number of'} processes`,
      `swap: ferrets may use ${resolved.fleet.swapMax === null ? 'any' : `up to ${formatBytes(resolved.fleet.swapMax)} of`} swap`,
    );
  } else if (kind === 'priority') {
    lines.push(
      'macOS: lower CPU and disk priority only; memory is watched, not capped',
      `each ferret is watched against ${memory(resolved.perFerret.memoryHigh)} of memory`,
    );
  } else {
    lines.push(`limits not enforced: ${because ?? 'unknown'}`);
    if (resolved.enabled && explicit)
      lines.push(`${input.file} says enabled: true, so a ferret that cannot be limited will not start`);
  }
  const step = ownerStep(host, input.uid);
  if (kind === 'cgroups' && step !== undefined)
    lines.push(step.sentence, ...step.commands.map(command => `  ${command}`));
  const slowed = input.live.throttled;
  if (kind === 'cgroups')
    lines.push(
      slowed.length === 0
        ? 'no ferret is slowed for memory now'
        : `${plural(slowed.length, 'ferret', 'ferrets')} slowed for memory now${
            slowed.length <= 3 ? `: ${slowed.map(entry => entry.callsign ?? entry.sessionId).join(', ')}` : ''
          }`,
    );
  for (const entry of input.live.killed.slice(-3).reverse())
    lines.push(
      `killed for memory: ${entry.callsign ?? 'a ferret'} ${input.clock(entry.at)}${
        entry.what === undefined
          ? ''
          : ` (${entry.what}${entry.bytes === undefined ? '' : `, ${formatBytes(entry.bytes)}`})`
      }`,
    );
  if (kind === 'priority' && input.live.overBudget.length > 0)
    lines.push(
      `${plural(input.live.overBudget.length, 'ferret is', 'ferrets are')} over their memory share now (not capped): ${input.live.overBudget
        .map(entry => `${entry.callsign ?? entry.sessionId} ${formatBytes(entry.bytes)}`)
        .join(', ')}`,
    );
  return {
    switchedOn: resolved.enabled,
    enforcement: kind,
    ...(because === undefined ? {} : { notEnforcedBecause: because }),
    explicit,
    platform: host.platform,
    budget: {
      ceilingBytes: host.memoryCeilingBytes,
      physicalBytes: host.physicalBytes,
      swapBytes: host.swapBytes,
      cpus: host.cpus,
      ...(host.pidMax === undefined ? {} : { pidMax: host.pidMax }),
      source: host.ceilingSource,
      reserveBytes: resolved.reserveBytes,
    },
    fleet: {
      cpuWeight: resolved.fleet.cpuWeight,
      memoryHighBytes: bytesOrNone(resolved.fleet.memoryHigh),
      memoryMaxBytes: bytesOrNone(resolved.fleet.memoryMax),
      swapMaxBytes: bytesOrNone(resolved.fleet.swapMax),
      tasksMax: resolved.fleet.tasksMax,
      cpuPercent: resolved.fleet.cpuPercent,
    },
    perFerret: {
      cpuWeight: resolved.perFerret.cpuWeight,
      interactiveCpuWeight: resolved.perFerret.interactiveCpuWeight,
      memoryHighBytes: bytesOrNone(resolved.perFerret.memoryHigh),
      memoryMaxBytes: bytesOrNone(resolved.perFerret.memoryMax),
      tasksMax: resolved.perFerret.tasksMax,
      cpuPercent: resolved.perFerret.cpuPercent,
    },
    daemonCpuWeight: DAEMON_CPU_WEIGHT,
    voiceCpuWeight: VOICE_CPU_WEIGHT,
    disk: {
      ionice: resolved.ionice,
      ...(input.disk.scheduler === undefined ? {} : { scheduler: input.disk.scheduler }),
      effect,
    },
    throttled: input.live.throttled.map(entry => ({
      sessionId: entry.sessionId,
      ...(entry.callsign === undefined ? {} : { callsign: entry.callsign }),
    })),
    killed: input.live.killed.map(entry => ({
      sessionId: entry.sessionId ?? 'unknown',
      ...(entry.callsign === undefined ? {} : { callsign: entry.callsign }),
      at: entry.at,
      ...(entry.what === undefined ? {} : { what: entry.what }),
      ...(entry.bytes === undefined ? {} : { bytes: entry.bytes }),
    })),
    overBudget: input.live.overBudget.map(entry => ({
      sessionId: entry.sessionId,
      ...(entry.callsign === undefined ? {} : { callsign: entry.callsign }),
      bytes: entry.bytes,
    })),
    file: input.file,
    ...(step === undefined ? {} : { ownerStep: [...step.commands] }),
    lines,
    warnings: [...resolved.warnings, ...input.warnings],
  };
}
