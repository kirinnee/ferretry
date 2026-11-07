/**
 * Everything the ferret-limits domain needs from outside itself.
 *
 * Each of these is a fact this daemon cannot compute: what the host manager says when it is asked
 * something, what the kernel says a cgroup has done, how much memory the user may spend, which disk
 * scheduler the state home sits on, and what one session's own document says about it. They are
 * declared here and implemented in `adapters/cgroups`.
 *
 * EVERY READ IS ASYNC. Nothing here may block the daemon's one thread (docs/performance.md).
 */

/** One host-manager invocation's outcome. Non-zero is a refusal to report, never a throw. */
export interface CgroupCommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs one host-manager command. The argv is complete, including the executable. */
export interface CgroupCommandPort {
  execute(argv: readonly string[]): Promise<CgroupCommandResult>;
}

/**
 * Where one live pid sits in the cgroup tree, verbatim (`/proc/<pid>/cgroup`). It THROWS rather than
 * answering `undefined` for an unreadable pid: an empty answer would be indistinguishable from
 * "definitely outside every managed slice", a claim this daemon must never make without evidence.
 */
export interface CgroupPlacementPort {
  placement(pid: number): Promise<string>;
}

/**
 * The machine as the limits need it, measured once at boot.
 *
 * `memoryCeilingBytes` is what the USER may spend, not what the machine has: min(physical RAM, every
 * finite `memory.max` and `memory.high` on the daemon's own ancestor cgroups). On a box with 61 GiB of
 * RAM and a 48 GiB `MemoryHigh` on the user slice it is 48 GiB, and that — not 61 — is the budget the
 * fleet must stay under so the kernel never asks the daemon to reclaim.
 */
export interface CgroupHostFacts {
  /** `linux`, `darwin`, … — whatever the runtime reports. */
  readonly platform: string;
  /** Whether this host presents the unified cgroup hierarchy. */
  readonly unifiedHierarchy: boolean;
  readonly cpus: number;
  readonly physicalBytes: number;
  readonly memoryCeilingBytes: number;
  /** What set the ceiling, in words (`physical memory`, `memory.high of user-1000.slice`). */
  readonly ceilingSource: string;
  readonly swapBytes: number;
  /** `/proc/sys/kernel/pid_max`; absent where there is none. */
  readonly pidMax?: number;
  /**
   * The ancestor limit that holds the budget below the machine's RAM, when there is one: the unit it is set
   * on (`user-1000.slice`) and the drop-in file that sets it, when one could be found.
   */
  readonly ceilingCap?: {
    readonly unit: string;
    readonly file: 'memory.max' | 'memory.high';
    readonly dropIn?: string;
  };
  /** The daemon's own cgroup path below the cgroup root (`/user.slice/...`); absent off cgroup v2. */
  readonly ownCgroup?: string;
}

/** Whether the user's systemd manager answers, which is what a scope launch needs. */
export type UserManagerProbe = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** What `memory.events` of one cgroup counted (kernel cgroup-v2 documentation). */
export interface MemoryEvents {
  /** Times usage went over `memory.high` and the cgroup was throttled and reclaimed. */
  readonly high: number;
  readonly max: number;
  /** Times the cgroup hit `memory.max` and an OOM kill was considered. */
  readonly oom: number;
  /** Processes killed for memory in this cgroup. */
  readonly oomKill: number;
}

/**
 * The limits a cgroup actually holds, read back from its own control files — not what was asked for.
 * `null` is "no cap" (`max`); a field that could not be read is absent.
 */
export interface AppliedCaps {
  readonly memoryHigh?: number | null;
  readonly memoryMax?: number | null;
  readonly swapMax?: number | null;
  readonly tasksMax?: number | null;
  readonly cpuWeight?: number;
  /** Share of this machine, parsed from cpu.max; null means no quota, absent means unreadable. */
  readonly cpuPercent?: number | null;
}

/** Whether the voice worker's slice is live, so its weight is one the kernel is applying. */
export type VoiceState = 'running' | 'not-running' | 'unknown';

/**
 * The CPU weights the kernel holds for the two services beside the fleet, read back from their cgroups —
 * not the numbers their units were written with. A weight that could not be read is absent.
 */
export interface ServiceWeights {
  readonly daemon?: number;
  readonly voice?: number;
  readonly voiceState: VoiceState;
}

export interface ServiceWeightsPort {
  /** Never throws: an unreadable file is an absent weight. */
  read(): Promise<ServiceWeights>;
}

/** One per-ferret slice (or a per-launch agent scope) and what the kernel says about its combined memory. */
export interface ScopeSighting {
  /** The per-ferret slice unit name, or a per-launch `<product>-agent-<id>-<nonce>.scope`. */
  readonly scope: string;
  readonly events: MemoryEvents;
  /** `memory.current`; absent where unreadable. */
  readonly currentBytes?: number;
  /** `memory.high`, as a number; absent for `max`. */
  readonly highBytes?: number;
  /** What this group actually holds now, read back from its control files. */
  readonly applied?: AppliedCaps;
}

/** The fleet slice as the kernel reports it. */
export interface FleetSighting {
  readonly events: MemoryEvents;
  /** The fleet's OWN events; memory.events above also includes its children. */
  readonly localEvents?: MemoryEvents;
  /** Shared browser child events, accounted separately so they never implicate a ferret. */
  readonly browserEvents?: MemoryEvents;
  /** What the fleet slice holds now. */
  readonly applied?: AppliedCaps;
  readonly scopes: readonly ScopeSighting[];
}

/** Reads the fleet slice and its scopes from the cgroup filesystem. Resolves `undefined` where there is none. */
export interface FleetMemoryPort {
  read(): Promise<FleetSighting | undefined>;
  /** The biggest processes inside one scope, largest first. Empty where unreadable. */
  largest(scope: string): Promise<readonly TreeProcess[]>;
}

/** What disk scheduler the state home's disk uses, and which disk that is. */
export interface DiskSchedulerReading {
  readonly device?: string;
  /** The active scheduler (`none`, `mq-deadline`, `bfq`, `kyber`), when readable. */
  readonly scheduler?: string;
}

export interface DiskSchedulerPort {
  read(): Promise<DiskSchedulerReading>;
}

/** One process in a ferret's tree, with the memory it holds. */
export interface TreeProcess {
  readonly argv: string;
  readonly rssBytes: number;
}

/** A ferret's resident memory where there are no cgroups (macOS). */
export interface SessionMemoryPort {
  /** The whole subtree's resident memory, or `undefined` where unreadable (macOS watch). */
  total(sessionId: string): Promise<number | undefined>;
  /** Every live session id this daemon owns (macOS watch). */
  sessions(): Promise<readonly string[]>;
}

/** Writes a note to a session's own journal. Best effort: a failure is the caller's to ignore. */
export interface SessionNotePort {
  note(
    sessionId: string,
    kind: 'memory_throttled' | 'memory_killed',
    data: Readonly<Record<string, unknown>>,
  ): Promise<void>;
  /** The session's callsign, when it has one. */
  callsign(sessionId: string): Promise<string | undefined>;
}

/** The durable spawn facts one session's own document records. */
export interface SessionSpawnFacts {
  readonly label?: string;
  /** The session that spawned this one, when a spawn recorded one. */
  readonly parent?: string;
  readonly wardenLineage?: boolean;
  /** A person is at this ferret (`mode: interactive`). */
  readonly interactive?: boolean;
}

/** One session's durable spawn facts, or `undefined` when the document cannot be read as a document. */
export interface SessionSpawnFactsPort {
  facts(sessionId: string): Promise<SessionSpawnFacts | undefined>;
}
