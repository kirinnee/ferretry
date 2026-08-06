/**
 * Everything the cgroup domain needs from outside itself.
 *
 * Every one of these is a fact this daemon cannot compute: what the host manager says when it is
 * told to change a unit, where a live pid actually sits in the cgroup tree, how much CPU and RAM
 * this machine has, what the operator last saved, which panes are alive, and what one session's own
 * durable document says about it. They are declared here and implemented in `adapters/cgroups`.
 */

import type { CgroupConfig } from '@ferretry/protocol';
import type { CgroupApplyStatus } from './status.ts';

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
 * Where one live pid sits in the cgroup tree, verbatim.
 *
 * It THROWS rather than answering `undefined` for an unreadable pid, and the domain converts that
 * into a per-session warning plus a conservative restart requirement. The distinction matters: an
 * empty answer would be indistinguishable from "definitely outside every managed slice", which is
 * exactly the claim this daemon must never make without evidence.
 */
export interface CgroupPlacementPort {
  placement(pid: number): Promise<string>;
}

/** The host as the conversion from percentages needs it. Resolved once by an adapter, because a
 *  machine does not grow CPUs while a daemon runs, and injected as a value so every derivation in
 *  the domain reads the same numbers. */
export interface CgroupHostFacts {
  /** `linux`, `darwin`, … — whatever the runtime reports. */
  readonly platform: string;
  /** Whether this host presents the unified hierarchy these limits are written against. */
  readonly unifiedHierarchy: boolean;
  readonly cpus: number;
  readonly memoryBytes: number;
}

/**
 * The operator's saved configuration, in its own document.
 *
 * `read` hands back RAW parsed JSON, never a typed value: the domain decides what an unreadable or
 * invalid document means, and an adapter that parsed would own a second copy of that policy.
 */
export interface CgroupConfigStore {
  read(): Promise<unknown>;
  write(config: CgroupConfig): Promise<void>;
}

/**
 * The durable record of what the last save could not apply live.
 *
 * A SECOND DOCUMENT RATHER THAN A FIELD ON THE FIRST. The configuration is what an operator asked
 * for and the evidence is what this host did with it; folding them together would make a
 * read-modify-write of the operator's own numbers part of recording a host refusal. `read` hands
 * back raw parsed JSON for the same reason the configuration store does — the domain owns what an
 * absent or damaged record MEANS, and the two answers are deliberately different.
 */
export interface CgroupApplyStatusStore {
  read(): Promise<unknown>;
  write(status: CgroupApplyStatus): Promise<void>;
}

/** One live managed pane, from this daemon's own durable registration ledger. */
export interface ManagedPane {
  readonly sessionId: string;
  readonly pid: number;
}

/**
 * A pane this daemon registered whose live identity could NOT be established.
 *
 * It is reported rather than dropped because the two are opposite claims: a dropped registration
 * reads as "this daemon owns no such pane", which would silently pass over a running agent, and a
 * pid offered without proof would let a limit change address whatever now holds that number.
 */
export interface UnprovenPane {
  readonly sessionId: string;
  /** Why, in the operator's vocabulary. */
  readonly failure: string;
}

/** What the ledger could and could not establish about this daemon's live panes. */
export interface LivePanes {
  readonly panes: readonly ManagedPane[];
  readonly unproven: readonly UnprovenPane[];
  /** Set exactly when the ledger itself could not be enumerated, so `panes` is not the whole set
   *  and no claim about "every live session" may be made from it. */
  readonly incomplete?: string;
}

/** The live panes a limit change could reach. Never tmux discovery: a pane this daemon did not
 *  register is not a pane it may reconfigure. */
export interface CgroupPaneLedger {
  live(): Promise<LivePanes>;
}

/**
 * The durable spawn facts one session's own document records.
 *
 * Deliberately narrower than the session document: exclusion is decided from the warden label the
 * spawn recorded, the link to whatever spawned it, and the lineage stamp meant to be carried forward
 * — and declaring exactly those three keeps the decision independent of everything else a session
 * document holds. See `exemption.ts` for which of them production actually writes today.
 */
export interface SessionSpawnFacts {
  readonly label?: string;
  /** The session that spawned this one, when a spawn recorded one. */
  readonly parent?: string;
  readonly wardenLineage?: boolean;
}

/** One session's durable spawn facts, or `undefined` when the document cannot be read as a
 *  document. The two callers resolve that absence in opposite, deliberate directions — see
 *  `exemption.ts`. */
export interface SessionSpawnFactsPort {
  facts(sessionId: string): Promise<SessionSpawnFacts | undefined>;
}
