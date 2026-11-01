/**
 * Moving a ferret that hit a limit — the loop that turns `auto-migrate.ts`'s rules into moves.
 *
 * WHY THIS IS NOT A VERDICT. Like auto-revive, a move here carries out no judgement of an LLM or of Jev: it is a
 * rule about a recorded fact — the ferret's login is out of quota, or past its hard budget — and the owner's
 * explicit `autoMigrate` setting. So it spends nothing, and it is listed under Recent actions as `auto`.
 *
 * THE MOVE IS `fy migrate`'S. Same session id, same conversation, same card and lineage: the migration restamps
 * the ferret's login and relaunches its conversation there, through the migration's own preflight. The only
 * thing the Warden adds is choosing the login, and — when the owner allowed it — clearing the way.
 *
 * WHAT IT NEVER DOES:
 * - move a ferret with an input card open, a secret it holds, or a prompt waiting on the owner (`ownerHold`);
 * - move one more than `maxMovesPerHour` times an hour;
 * - move one onto a login that is not ready, holds spend, is out of quota, is the one that ran out, or — unless
 *   named — belongs to another provider (`chooseMoveTarget`);
 * - stop a background job the owner did not let it stop. Without `forceStopBackground` the ferret is ASKED, with
 *   the same message `fy migrate` sends, and given `waitMinutes`; then the owner is told.
 *
 * Each reason a ferret is not moved is recorded ONCE per episode (the same trigger, login and reason), and the
 * owner is told once, so a standing refusal never refills Recent actions every sweep.
 */

import type { WardenAction, WardenAutoMigrateTrigger, WardenConfig } from '@ferretry/protocol';
import type { AgentJob } from '../migrate/agent-jobs.ts';
import type { PackFleetFacts } from '../pack/recommend.ts';
import {
  type AutoMigrateMemory,
  type AutoMigrateSubject,
  askExpired,
  autoMigrateHoldKey,
  chooseMoveTarget,
  EMPTY_AUTO_MIGRATE_MEMORY,
  movesInLastHour,
  moveTriggers,
  parseAutoMigrateMemory,
  pruneAutoMigrateMemory,
  rateLimitedSubjects,
  recordMove,
  sessionMemory,
  triedLine,
  withSession,
} from './auto-migrate.ts';
import { isoFromMs } from './time.ts';
import type { WardenSessionView } from './types.ts';

/** What stopping a ferret's own jobs did: what was stopped, and what is somehow still running. */
export interface StoppedAgentJobs {
  readonly stopped: readonly AgentJob[];
  readonly survivors: readonly AgentJob[];
}

export interface WardenAutoMigrateNotice {
  readonly sessionId: string;
  readonly title: string;
  readonly subject: string;
  readonly why: string;
}

export interface WardenAutoMigratePorts {
  /** The fleet's facts as `fy recommend` reads them. Throws when they cannot be read: no login is chosen blind. */
  facts(): Promise<PackFleetFacts>;
  /**
   * Why the ferret must not be moved right now — an input card open, a secret it holds, a surface it handed to
   * the owner, a prompt waiting on them — or `undefined`. Total: a check that cannot be made is a reason.
   */
  ownerHold(sessionId: string): Promise<string | undefined>;
  /** The ferret's own background jobs that keep the migration's safety check from passing. Throws when it cannot look. */
  blockingJobs(sessionId: string): Promise<readonly AgentJob[]>;
  /** Ask the ferret to stop them, with `fy migrate`'s own message. */
  askToStopJobs(sessionId: string): Promise<void>;
  /** Stop the ferret's own jobs under its own pane, and nothing else. */
  stopJobs(sessionId: string): Promise<StoppedAgentJobs>;
  /** Move the ferret — same session — to `agent`. `note` opens the turn it is handed. Throws when it did not move. */
  migrate(sessionId: string, request: { readonly agent: string; readonly note: string }): Promise<void>;
  /**
   * The login the ferret is on NOW, read inside the mover's lock — a sweep and a budget stop may both have meant to
   * move it, and the second must see that the first already did. `undefined` when it cannot be read or is gone.
   */
  agentOf(sessionId: string): Promise<string | undefined>;
  /**
   * Who has been moved, when, and what each was asked or held for (`auto-migrate.ts`). The mover owns it: every
   * read and write happens inside its one lock, so two paths can never both pass the hourly cap.
   */
  readonly ledger: { read(): Promise<unknown>; write(memory: AutoMigrateMemory): Promise<void> };
  /** One notice to the owner. Total. */
  notifyOwner(notice: WardenAutoMigrateNotice): Promise<void>;
  /** Append one Warden event to the ferret's own journal. Total. */
  emit(sessionId: string, type: string, data: Readonly<Record<string, unknown>>): Promise<void>;
  journal: { record(type: string, data: Readonly<Record<string, unknown>>): void };
}

export interface WardenAutoMigrateInput {
  readonly fleet: readonly WardenSessionView[];
  readonly config: WardenConfig;
  readonly nowMs: number;
}

export interface WardenAutoMigrateResult {
  readonly actions: readonly WardenAction[];
  /** The ferrets moved this run, so the sweep does not flag them on the same pass. */
  readonly moved: ReadonlySet<string>;
}

interface Considered {
  readonly memory: AutoMigrateMemory;
  readonly action?: WardenAction;
  readonly moved: boolean;
}

/** Reasons that end an episode: nothing is tried again until the ferret is on another login or off its limit. */
const STICKY_REASONS = ['failed', 'survivors', 'error'] as const;

/** Whether the run may wait for the ferret: a sweep can come back; a budget stop cannot. */
type Pace = 'sweep' | 'now';

const TRIGGER_WORDS: Readonly<Record<WardenAutoMigrateTrigger, (agent: string) => string>> = {
  rate_limited: agent => `${agent} hit its usage limit`,
  budget_exceeded: agent => `${agent} passed its hard spend budget on this machine`,
};

/**
 * A job as the OWNER's words name it — a notice that pings their phone, Recent actions a paired device reads, the
 * journal: its pid and its program, never its command line, which can carry a credential the vault does not know.
 * The ferret that started it is told the whole (redacted) command in its own turn ({@link moveNote}).
 */
const program = (job: AgentJob): string => job.command.trim().split(/\s+/u)[0]?.split('/').at(-1) || '?';
const jobList = (jobs: readonly AgentJob[]): string => jobs.map(job => `pid ${job.pid} (${program(job)})`).join(', ');
const jobFacts = (jobs: readonly AgentJob[]) => jobs.map(job => ({ pid: job.pid, program: program(job) }));
const commandList = (jobs: readonly AgentJob[]): string =>
  jobs.map(job => `pid ${job.pid} (${job.command})`).join(', ');

const sameMemory = (left: AutoMigrateMemory, right: AutoMigrateMemory): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const failureMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export class WardenAutoMigrateService {
  /**
   * The one lock every move runs under — a sweep's and a budget stop's alike. The ledger is read and written only
   * inside it, so the hourly cap counts every move however the two paths interleave, and a ferret is never
   * considered by both at once.
   */
  private lock: Promise<unknown> = Promise.resolve();

  constructor(private readonly ports: WardenAutoMigratePorts) {}

  /** One sweep's moves: every ferret sitting on a usage limit, when that is a trigger. */
  async run(input: WardenAutoMigrateInput): Promise<WardenAutoMigrateResult> {
    const { fleet, config, nowMs } = input;
    const subjects = rateLimitedSubjects(fleet, config);
    const live = new Set(fleet.map(view => view.config.id));
    return await this.exclusive(async () => {
      const read = await this.load();
      let memory = pruneAutoMigrateMemory(this.settle(read, subjects), live, nowMs);
      if (!sameMemory(memory, read)) await this.ports.ledger.write(memory);
      const actions: WardenAction[] = [];
      const moved = new Set<string>();
      for (const subject of subjects) {
        const result = await this.guarded(subject, config, memory, nowMs, 'sweep');
        // Written after each ferret, not at the end: a daemon that dies mid-run has already counted the moves made.
        if (!sameMemory(result.memory, memory)) await this.ports.ledger.write(result.memory);
        memory = result.memory;
        if (result.action !== undefined) actions.push(result.action);
        if (result.moved) moved.add(subject.id);
      }
      return { actions, moved };
    });
  }

  /**
   * One ferret, now, for a trigger outside the sweep — a login past its hard budget, about to be stopped. There
   * is no waiting here: a ferret whose jobs would have to be asked about is left to the stop that was coming.
   * `away` is true when the ferret is no longer on the login that ran out — moved now, or by a sweep that held the
   * lock first — so there is nothing left on that login to stop.
   */
  async relocate(
    subject: AutoMigrateSubject,
    config: WardenConfig,
    nowMs: number,
  ): Promise<{ readonly action?: WardenAction; readonly away: boolean }> {
    if (!moveTriggers(config).has(subject.trigger)) return { away: false };
    return await this.exclusive(async () => {
      if ((await this.ports.agentOf(subject.id)) !== subject.agent) return { away: true };
      const memory = await this.load();
      const result = await this.guarded(subject, config, memory, nowMs, 'now');
      if (!sameMemory(result.memory, memory)) await this.ports.ledger.write(result.memory);
      return { ...(result.action === undefined ? {} : { action: result.action }), away: result.moved };
    });
  }

  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.lock.then(work, work);
    this.lock = run.catch(() => undefined);
    return await run;
  }

  /** The ledger as stored. One that cannot be read as a ledger starts over, and says so in the journal. */
  private async load(): Promise<AutoMigrateMemory> {
    const parsed = parseAutoMigrateMemory(await this.ports.ledger.read());
    if (parsed !== undefined) return parsed;
    this.ports.journal.record('fleet.warden_auto_migrate_ledger_reset', {});
    return EMPTY_AUTO_MIGRATE_MEMORY;
  }

  /**
   * A ferret that is no longer a candidate — its limit reset, it was moved, it finished — has no episode left:
   * whatever it was asked or held for is over, so a new limit tomorrow is told about afresh.
   */
  private settle(memory: AutoMigrateMemory, subjects: readonly AutoMigrateSubject[]): AutoMigrateMemory {
    const current = new Map(subjects.map(subject => [subject.id, subject]));
    let next = memory;
    for (const [id, session] of Object.entries(memory.sessions)) {
      const subject = current.get(id);
      const askedStill = session.asked !== undefined && subject !== undefined && session.asked.from === subject.agent;
      const heldStill =
        session.held !== undefined &&
        subject !== undefined &&
        session.held.startsWith(`${subject.trigger}|${subject.agent}|`);
      if (askedStill === (session.asked !== undefined) && heldStill === (session.held !== undefined)) continue;
      next = withSession(next, id, entry => ({
        moves: entry.moves,
        ...(askedStill && entry.asked !== undefined ? { asked: entry.asked } : {}),
        ...(heldStill && entry.held !== undefined ? { held: entry.held } : {}),
      }));
    }
    return next;
  }

  private async guarded(
    subject: AutoMigrateSubject,
    config: WardenConfig,
    memory: AutoMigrateMemory,
    nowMs: number,
    pace: Pace,
  ): Promise<Considered> {
    try {
      // Moved since the fleet was read — by the other path, or by a person: this episode is over.
      if ((await this.ports.agentOf(subject.id)) !== subject.agent) return { memory, moved: false };
      return await this.consider(subject, config, memory, nowMs, pace);
    } catch (error) {
      // Nothing here may throw at the sweep or the budget tick: an unexpected failure is one failed action.
      this.ports.journal.record('fleet.warden_auto_migrate_failed', {
        sessionId: subject.id,
        message: failureMessage(error),
      });
      return this.hold(subject, memory, nowMs, 'error', `Not moved: ${failureMessage(error)}.`, 'failed');
    }
  }

  private async consider(
    subject: AutoMigrateSubject,
    config: WardenConfig,
    memory: AutoMigrateMemory,
    nowMs: number,
    pace: Pace,
  ): Promise<Considered> {
    const settings = config.autoMigrate;
    const because = TRIGGER_WORDS[subject.trigger](subject.agent);
    // A move that failed, or jobs that outlived being stopped, will not go better on the next sweep: the owner was
    // told, and this episode is theirs now.
    const held = sessionMemory(memory, subject.id).held;
    if (STICKY_REASONS.some(reason => held === autoMigrateHoldKey(subject, reason))) return { memory, moved: false };

    const owner = await this.ports.ownerHold(subject.id);
    if (owner !== undefined)
      return this.hold(subject, memory, nowMs, 'owner', `Not moved although ${because}: ${owner}.`);

    const moves = movesInLastHour(memory, subject.id, nowMs);
    if (moves >= settings.maxMovesPerHour)
      return await this.holdAndTell(
        subject,
        memory,
        nowMs,
        'cap',
        `Not moved although ${because}: it was already moved ${moves === 1 ? 'once' : `${moves} times`} in the last hour, the most the Warden settings allow.`,
      );

    const choice = chooseMoveTarget({
      source: { agent: subject.agent, harness: subject.harness },
      facts: await this.ports.facts(),
      targets: settings.targets,
    });
    if (choice.kind === 'none')
      return await this.holdAndTell(
        subject,
        memory,
        nowMs,
        'no_target',
        `Not moved although ${because}: no login could take it. ${triedLine(choice.tried)}`,
      );
    const target = choice.runtime;

    const jobs = await this.ports.blockingJobs(subject.id);
    let stopped: readonly AgentJob[] = [];
    let next = memory;
    if (jobs.length > 0) {
      if (settings.forceStopBackground) {
        const result = await this.ports.stopJobs(subject.id);
        stopped = result.stopped;
        await this.ports.emit(subject.id, 'warden.auto_migrate_stopped_jobs', {
          stopped: jobFacts(result.stopped),
          survivors: jobFacts(result.survivors),
        });
        this.ports.journal.record('fleet.warden_auto_migrate_stopped_jobs', {
          sessionId: subject.id,
          stopped: result.stopped.map(job => job.pid),
          survivors: result.survivors.map(job => job.pid),
        });
        if (result.survivors.length > 0)
          return await this.holdAndTell(
            subject,
            memory,
            nowMs,
            'survivors',
            `Not moved although ${because}: these background jobs were still running after the Warden stopped them: ${jobList(result.survivors)}.`,
          );
      } else if (pace === 'now') {
        return this.hold(
          subject,
          memory,
          nowMs,
          'jobs',
          `Not moved although ${because}: its background jobs are still running (${jobList(jobs)}), and the Warden may not stop them.`,
        );
      } else {
        const asked = sessionMemory(memory, subject.id).asked;
        if (asked === undefined || asked.from !== subject.agent) {
          await this.ports.askToStopJobs(subject.id);
          await this.ports.emit(subject.id, 'warden.auto_migrate_asked', {
            to: target.wrapper,
            jobs: jobs.map(job => job.pid),
            waitMinutes: settings.waitMinutes,
          });
          this.ports.journal.record('fleet.warden_auto_migrate_asked', {
            sessionId: subject.id,
            jobs: jobs.map(job => job.pid),
          });
          return {
            memory: withSession(memory, subject.id, entry => ({
              ...entry,
              asked: { at: isoFromMs(nowMs), trigger: subject.trigger, from: subject.agent },
            })),
            moved: false,
          };
        }
        if (!askExpired(asked, settings.waitMinutes, nowMs)) return { memory, moved: false };
        return await this.holdAndTell(
          subject,
          memory,
          nowMs,
          'jobs',
          `Not moved although ${because}: it was asked to stop its background jobs ${settings.waitMinutes} min ago and these still run: ${jobList(jobs)}.`,
        );
      }
    }

    const note = moveNote(subject.agent, target.wrapper, because, stopped);
    const base = {
      at: isoFromMs(nowMs),
      sessionId: subject.id,
      action: 'failover' as const,
      by: 'warden' as const,
      actor: 'auto' as const,
      agent: target.wrapper,
      fromAgent: subject.agent,
    };
    try {
      // NEVER FORCED, force-stop or not. Stopping its jobs is all the owner allowed; the migration's own safety
      // check then reads the pane afresh, and anything else in the way — work it cannot see, a blocker that is not
      // one of the ferret's jobs, a job that came back — still keeps the ferret where it is.
      await this.ports.migrate(subject.id, { agent: target.wrapper, note });
    } catch (error) {
      next = withSession(memory, subject.id, entry => ({ ...entry, held: autoMigrateHoldKey(subject, 'failed') }));
      const detail = `Tried to move it from ${subject.agent} to ${target.wrapper} because ${because}, and the move did not take: ${failureMessage(error)}.`;
      await this.tell(subject, `Moving ${subject.id} failed`, detail);
      return { memory: next, action: { ...base, outcome: 'failed', detail }, moved: false };
    }
    next = recordMove(memory, subject.id, nowMs);
    const detail =
      `Moved it from ${subject.agent} to ${target.wrapper} because ${because}.` +
      (stopped.length === 0 ? '' : ` Stopped its background jobs first: ${jobList(stopped)}.`);
    await this.ports.emit(subject.id, 'warden.auto_migrated', {
      from: subject.agent,
      to: target.wrapper,
      trigger: subject.trigger,
      ...(stopped.length === 0 ? {} : { stopped: jobFacts(stopped) }),
    });
    this.ports.journal.record('fleet.warden_auto_migrated', {
      sessionId: subject.id,
      from: subject.agent,
      to: target.wrapper,
      trigger: subject.trigger,
    });
    return { memory: next, action: { ...base, outcome: 'done', detail }, moved: true };
  }

  /** Record a reason the ferret was not moved, once per episode. */
  private hold(
    subject: AutoMigrateSubject,
    memory: AutoMigrateMemory,
    nowMs: number,
    reason: string,
    detail: string,
    outcome: 'held' | 'failed' = 'held',
  ): Considered {
    const key = autoMigrateHoldKey(subject, reason);
    const session = sessionMemory(memory, subject.id);
    if (session.held === key) return { memory, moved: false };
    return {
      memory: withSession(memory, subject.id, entry => ({ ...entry, held: key })),
      action: {
        at: isoFromMs(nowMs),
        sessionId: subject.id,
        action: 'failover',
        outcome,
        by: 'warden',
        actor: 'auto',
        fromAgent: subject.agent,
        detail,
      },
      moved: false,
    };
  }

  /** Record it once, and tell the owner the first time: this is a reason only they can clear. */
  private async holdAndTell(
    subject: AutoMigrateSubject,
    memory: AutoMigrateMemory,
    nowMs: number,
    reason: string,
    detail: string,
  ): Promise<Considered> {
    const held = this.hold(subject, memory, nowMs, reason, detail);
    if (held.action !== undefined) await this.tell(subject, `${subject.id} could not be moved`, detail);
    return held;
  }

  private async tell(subject: AutoMigrateSubject, title: string, detail: string): Promise<void> {
    await this.ports.notifyOwner({
      sessionId: subject.id,
      title,
      subject: detail,
      why:
        'The Warden moves a ferret whose login hit a limit to another login, as warden.yaml (autoMigrate) allows. ' +
        `Move it yourself with: fy migrate ${subject.id} -a <runtime>.`,
    });
  }
}

/** The opening of the turn a moved ferret is handed: where it is now, why, and what was stopped. */
export function moveNote(from: string, to: string, because: string, stopped: readonly AgentJob[]): string {
  const jobs =
    stopped.length === 0
      ? ''
      : ` To move you, it stopped these background jobs you had started: ${commandList(stopped)}. Start again any you still need.`;
  return `Ferretry's Warden moved you from ${from} to ${to} because ${because}.${jobs}`;
}
