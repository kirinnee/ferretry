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
import type { AppliedCaps, CgroupHostFacts, DiskSchedulerReading } from './ports.ts';
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

/** The kernel rounds a memory cap to a page, so two caps within a page are the same cap. */
const PAGE = 4096;

/** Whether a cap read back is the cap that was asked for. A field that could not be read matches anything. */
export function sameCap(applied: number | null | undefined, wanted: number | null): boolean {
  if (applied === undefined) return true;
  if (applied === null || wanted === null) return applied === wanted;
  return Math.abs(applied - wanted) < PAGE;
}

/** What a group of running ferrets was given, with the ones that differ from what a new ferret would get. */
function ferretsAgainst(
  scopes: readonly AppliedCaps[],
  wanted: { readonly memoryHigh: number | null; readonly memoryMax: number | null; readonly tasksMax: number | null },
): { readonly shown: AppliedCaps | undefined; readonly stale: number } {
  const matches = (caps: AppliedCaps): boolean =>
    sameCap(caps.memoryHigh, wanted.memoryHigh) &&
    sameCap(caps.memoryMax, wanted.memoryMax) &&
    sameCap(caps.tasksMax, wanted.tasksMax);
  const stale = scopes.filter(caps => !matches(caps));
  // When some differ, say what the MOST of them hold: the line is about what is running, not what will be.
  const shown = stale.length === 0 ? scopes[0] : (stale.length * 2 > scopes.length ? stale : scopes.filter(matches))[0];
  return { shown, stale: stale.length };
}

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
  // WHAT IS SHOWN IS WHAT THE KERNEL HOLDS, read back from the cgroup files — not what limits.yaml asks for.
  // A tightened cap reaches the fleet slice and each new ferret at the NEXT launch, and a running ferret keeps
  // the caps it started with, so the two can differ and the status says so instead of claiming the new number.
  const appliedFleet = input.live.applied?.fleet;
  const runningFerrets = input.live.applied?.scopes ?? [];
  const fleetShown = {
    memoryHigh: appliedFleet?.memoryHigh === undefined ? resolved.fleet.memoryHigh : appliedFleet.memoryHigh,
    memoryMax: appliedFleet?.memoryMax === undefined ? resolved.fleet.memoryMax : appliedFleet.memoryMax,
    swapMax: appliedFleet?.swapMax === undefined ? resolved.fleet.swapMax : appliedFleet.swapMax,
    tasksMax: appliedFleet?.tasksMax === undefined ? resolved.fleet.tasksMax : appliedFleet.tasksMax,
    cpuWeight: appliedFleet?.cpuWeight ?? resolved.fleet.cpuWeight,
  };
  const fleetBehind =
    appliedFleet !== undefined &&
    (!sameCap(appliedFleet.memoryHigh, resolved.fleet.memoryHigh) ||
      !sameCap(appliedFleet.memoryMax, resolved.fleet.memoryMax) ||
      !sameCap(appliedFleet.swapMax, resolved.fleet.swapMax) ||
      !sameCap(appliedFleet.tasksMax, resolved.fleet.tasksMax) ||
      (appliedFleet.cpuWeight !== undefined && appliedFleet.cpuWeight !== resolved.fleet.cpuWeight));
  const ferretsNow = ferretsAgainst(runningFerrets, resolved.perFerret);
  const ferretShown = ferretsNow.shown ?? resolved.perFerret;
  const ferretMemoryHigh =
    ferretShown.memoryHigh === undefined ? resolved.perFerret.memoryHigh : ferretShown.memoryHigh;
  const ferretMemoryMax = ferretShown.memoryMax === undefined ? resolved.perFerret.memoryMax : ferretShown.memoryMax;
  const ferretTasks = ferretShown.tasksMax === undefined ? resolved.perFerret.tasksMax : ferretShown.tasksMax;
  if (kind === 'cgroups') {
    const notYet =
      appliedFleet === undefined ? 'configured, not yet applied (the first ferret you start puts it in force): ' : '';
    lines.push(
      `${notYet}ferrets: memory ${memory(fleetShown.memoryHigh)} soft / ${memory(fleetShown.memoryMax)} hard of a ${formatBytes(host.memoryCeilingBytes)} user budget · CPU weight ${fleetShown.cpuWeight} (daemon ${DAEMON_CPU_WEIGHT}, voice ${VOICE_CPU_WEIGHT}) · disk priority: ${diskText}`,
      `each ferret: memory ${memory(ferretMemoryHigh)} soft / ${memory(ferretMemoryMax)} hard · up to ${ferretTasks ?? 'any number of'} processes${
        runningFerrets.length === 0 ? ' (set for ferrets you start; none is running under limits yet)' : ''
      }`,
      `swap: ferrets may use ${fleetShown.swapMax === null ? 'any' : `up to ${formatBytes(fleetShown.swapMax)} of`} swap`,
    );
    if (fleetBehind)
      lines.push(
        `limits.yaml now asks for ${memory(resolved.fleet.memoryHigh)} soft / ${memory(resolved.fleet.memoryMax)} hard for all ferrets together; that takes effect when the next ferret starts`,
      );
    if (ferretsNow.stale > 0)
      lines.push(
        `${plural(ferretsNow.stale, 'running ferret keeps', 'running ferrets keep')} the limits ${ferretsNow.stale === 1 ? 'it' : 'they'} started with; a new ferret gets ${memory(resolved.perFerret.memoryHigh)} soft / ${memory(resolved.perFerret.memoryMax)} hard`,
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
  if (kind === 'cgroups') {
    // A ferret is slowed by ITS OWN soft limit or, when they are all together past the fleet's, by the fleet's:
    // the second shows only on the fleet's counter, so it is said as a fact about everyone, not about one.
    if (input.live.fleetSlowed)
      lines.push('all ferrets are slowed for memory now: together they are past the soft limit for all ferrets');
    if (slowed.length > 0)
      lines.push(
        `${plural(slowed.length, 'ferret', 'ferrets')} slowed for memory now${
          slowed.length <= 3 ? `: ${slowed.map(entry => entry.callsign ?? entry.sessionId).join(', ')}` : ''
        }`,
      );
    else if (!input.live.fleetSlowed) lines.push('no ferret is slowed for memory now');
  }
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
      cpuWeight: fleetShown.cpuWeight,
      memoryHighBytes: bytesOrNone(fleetShown.memoryHigh),
      memoryMaxBytes: bytesOrNone(fleetShown.memoryMax),
      swapMaxBytes: bytesOrNone(fleetShown.swapMax),
      tasksMax: fleetShown.tasksMax,
      cpuPercent: resolved.fleet.cpuPercent,
    },
    perFerret: {
      cpuWeight: resolved.perFerret.cpuWeight,
      interactiveCpuWeight: resolved.perFerret.interactiveCpuWeight,
      memoryHighBytes: bytesOrNone(ferretMemoryHigh),
      memoryMaxBytes: bytesOrNone(ferretMemoryMax),
      tasksMax: ferretTasks,
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
