/**
 * What is in force, in plain words: the one place the sentences are written.
 *
 * `fy daemon status`, the app's limits panel and the session view all print what this builds, so the
 * words are decided once. No cgroup jargon reaches a person: "soft" and "hard" memory limits, "slowed"
 * and "killed", "disk priority", never `MemoryHigh` or `oom_kill`.
 *
 * Pure: no IO, no clock, no globals.
 */
import { GIBIBYTE, type LimitsConfig, type LimitsDiskEffect, type LimitsView, resolveLimits, VOICE_CPU_WEIGHT } from '../protocol/limits.ts';
import type { EnforcementState } from './enforcement.ts';
import { ownerStep } from './owner-step.ts';
import type { AppliedCaps, CgroupHostFacts, DiskSchedulerReading, ServiceWeights } from './ports.ts';
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
  /** The daemon's and the voice worker's CPU weights as the kernel holds them (Linux). */
  readonly services: ServiceWeights;
  readonly live: MemoryWatchState;
  readonly file: string;
  /** This user's id, for the one-time owner step. */
  readonly uid: number;
  /** Warnings from reading the machine (the daemon sitting inside the fleet slice, …). */
  readonly warnings: readonly string[];
  /** `2026-11-05T23:04:00Z` → `23:04`, in the machine’s own time. */
  readonly clock: (iso: string) => string;
}

/** What the kernel holds for the daemon and the voice worker; a worker that is not running has nothing applied. */
function servicesText(services: ServiceWeights): string {
  const voice =
    services.voiceState === 'not-running'
      ? `not running; gets ${VOICE_CPU_WEIGHT} when it starts`
      : (services.voice ?? 'unknown');
  return `daemon ${services.daemon ?? 'unknown'}, voice ${voice}`;
}

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

/** The kernel rounds a memory cap to a page, so two caps within a page are the same cap. */
const PAGE = 4096;

/** Whether a memory cap read back is the cap requested. An unreadable field confirms nothing. */
export function sameCap(applied: number | null | undefined, wanted: number | null): boolean {
  if (applied === undefined) return false;
  if (applied === null || wanted === null) return applied === wanted;
  return Math.abs(applied - wanted) < PAGE;
}

/** What a group of running ferrets was given, with the ones that differ from what a new ferret would get. */
function ferretsAgainst(
  scopes: readonly AppliedCaps[],
  wanted: {
    readonly memoryHigh: number | null;
    readonly memoryMax: number | null;
    readonly tasksMax: number | null;
    readonly cpuWeight: number;
    readonly interactiveCpuWeight: number;
    readonly cpuPercent: number | null;
  },
): { readonly shown: AppliedCaps | undefined; readonly stale: number } {
  // Missing measurements are reported separately as unknown, never evidence of an earlier cap.
  const matches = (caps: AppliedCaps): boolean =>
    (caps.memoryHigh === undefined || sameCap(caps.memoryHigh, wanted.memoryHigh)) &&
    (caps.memoryMax === undefined || sameCap(caps.memoryMax, wanted.memoryMax)) &&
    (caps.tasksMax === undefined || caps.tasksMax === wanted.tasksMax) &&
    (caps.cpuPercent === undefined || caps.cpuPercent === wanted.cpuPercent) &&
    (caps.cpuWeight === undefined ||
      caps.cpuWeight === wanted.cpuWeight ||
      caps.cpuWeight === wanted.interactiveCpuWeight);
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
  else if (input.launchFailure !== undefined) because = `the last ferret could not be limited (${input.launchFailure})`;
  else if (enforcement.kind === 'priority') {
    kind = enforcement.wrapper === 'none' ? 'none' : 'priority';
    if (enforcement.wrapper === 'none') because = 'this Mac has neither taskpolicy nor nice';
  } else kind = 'cgroups';

  const lines: string[] = [];
  const memory = (bytes: number | null | undefined): string =>
    bytes === undefined ? 'unknown' : bytes === null ? 'no limit' : formatBytes(bytes);
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
  const fleetShown = appliedFleet ?? resolved.fleet;
  const fleetBehind =
    appliedFleet !== undefined &&
    ((appliedFleet.memoryHigh !== undefined && !sameCap(appliedFleet.memoryHigh, resolved.fleet.memoryHigh)) ||
      (appliedFleet.memoryMax !== undefined && !sameCap(appliedFleet.memoryMax, resolved.fleet.memoryMax)) ||
      (appliedFleet.swapMax !== undefined && !sameCap(appliedFleet.swapMax, resolved.fleet.swapMax)) ||
      (appliedFleet.tasksMax !== undefined && appliedFleet.tasksMax !== resolved.fleet.tasksMax) ||
      (appliedFleet.cpuWeight !== undefined && appliedFleet.cpuWeight !== resolved.fleet.cpuWeight) ||
      (appliedFleet.cpuPercent !== undefined && appliedFleet.cpuPercent !== resolved.fleet.cpuPercent));
  const ferretsNow = ferretsAgainst(runningFerrets, resolved.perFerret);
  const ferretShown = ferretsNow.shown ?? resolved.perFerret;
  const ferretMemoryHigh = ferretShown.memoryHigh;
  const ferretMemoryMax = ferretShown.memoryMax;
  const ferretTasks = ferretShown.tasksMax;
  if (kind === 'cgroups') {
    const notYet =
      appliedFleet === undefined ? 'configured, not yet applied (the first ferret you start puts it in force): ' : '';
    lines.push(
      `${notYet}ferrets: memory ${memory(fleetShown.memoryHigh)} soft / ${memory(fleetShown.memoryMax)} hard of a ${formatBytes(host.memoryCeilingBytes)} user budget · CPU weight ${fleetShown.cpuWeight ?? 'unknown'} (${servicesText(input.services)}) · disk priority: ${diskText}`,
      `each ferret: memory ${memory(ferretMemoryHigh)} soft / ${memory(ferretMemoryMax)} hard · up to ${ferretTasks === undefined ? 'unknown' : (ferretTasks ?? 'any number of')} processes${
        runningFerrets.length === 0 ? ' (set for ferrets you start; none is running under limits yet)' : ''
      }`,
      `swap: ferrets may use ${fleetShown.swapMax === undefined ? 'an unknown amount of' : fleetShown.swapMax === null ? 'any' : `up to ${formatBytes(fleetShown.swapMax)} of`} swap`,
    );
    if (fleetBehind)
      lines.push(
        `limits.yaml now asks for ${memory(resolved.fleet.memoryHigh)} soft / ${memory(resolved.fleet.memoryMax)} hard for all ferrets together, up to ${resolved.fleet.tasksMax ?? 'any number of'} processes and CPU weight ${resolved.fleet.cpuWeight}; that takes effect when the next ferret starts`,
      );
    if (ferretsNow.stale > 0)
      lines.push(
        `${plural(ferretsNow.stale, 'running ferret keeps', 'running ferrets keep')} the limits ${ferretsNow.stale === 1 ? 'it' : 'they'} started with; a new ferret gets ${memory(resolved.perFerret.memoryHigh)} soft / ${memory(resolved.perFerret.memoryMax)} hard and up to ${resolved.perFerret.tasksMax ?? 'any number of'} processes`,
      );
    if (
      appliedFleet !== undefined &&
      ['memoryHigh', 'memoryMax', 'swapMax', 'tasksMax', 'cpuWeight', 'cpuPercent'].some(
        key => appliedFleet[key as keyof AppliedCaps] === undefined,
      )
    )
      lines.push('some applied fleet limits are unknown: their control files could not be read');
    if (
      runningFerrets.some(caps =>
        ['memoryHigh', 'memoryMax', 'tasksMax', 'cpuWeight', 'cpuPercent'].some(
          key => caps[key as keyof AppliedCaps] === undefined,
        ),
      )
    )
      lines.push('some running ferret limits are unknown: their control files could not be read');
  } else if (kind === 'priority') {
    lines.push(
      'macOS: lower CPU and disk priority only; memory is watched, not capped',
      `each ferret is watched against ${memory(resolved.perFerret.memoryHigh)} of memory`,
    );
  } else {
    lines.push(`limits not enforced: ${because ?? 'unknown'}`);
    if (resolved.enabled && explicit && host.platform === 'linux')
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
      cpuWeight: appliedFleet?.cpuWeight,
      memoryHighBytes: appliedFleet?.memoryHigh,
      memoryMaxBytes: appliedFleet?.memoryMax,
      swapMaxBytes: appliedFleet?.swapMax,
      tasksMax: appliedFleet?.tasksMax,
      cpuPercent: appliedFleet?.cpuPercent,
    },
    perFerret: {
      cpuWeight: ferretsNow.shown?.cpuWeight,
      memoryHighBytes: ferretsNow.shown?.memoryHigh,
      memoryMaxBytes: ferretsNow.shown?.memoryMax,
      tasksMax: ferretsNow.shown?.tasksMax,
      cpuPercent: ferretsNow.shown?.cpuPercent,
    },
    configured: {
      fleet: {
        cpuWeight: resolved.fleet.cpuWeight,
        memoryHighBytes: resolved.fleet.memoryHigh,
        memoryMaxBytes: resolved.fleet.memoryMax,
        swapMaxBytes: resolved.fleet.swapMax,
        tasksMax: resolved.fleet.tasksMax,
        cpuPercent: resolved.fleet.cpuPercent,
      },
      perFerret: {
        cpuWeight: resolved.perFerret.cpuWeight,
        interactiveCpuWeight: resolved.perFerret.interactiveCpuWeight,
        memoryHighBytes: resolved.perFerret.memoryHigh,
        memoryMaxBytes: resolved.perFerret.memoryMax,
        tasksMax: resolved.perFerret.tasksMax,
        cpuPercent: resolved.perFerret.cpuPercent,
      },
    },
    // Applied values only, like the fleet's: omitted where the kernel was not asked or could not say.
    ...(kind === 'cgroups' && input.services.daemon !== undefined ? { daemonCpuWeight: input.services.daemon } : {}),
    ...(kind === 'cgroups' && input.services.voice !== undefined ? { voiceCpuWeight: input.services.voice } : {}),
    ...(kind === 'cgroups' ? { voiceState: input.services.voiceState } : {}),
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
