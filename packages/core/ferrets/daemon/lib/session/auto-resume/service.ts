import type { AutoResumeSummary } from '../../protocol/auto-resume.ts';
import {
  AnswerLost,
  bootNotice,
  freshCandidates,
  isUpElsewhere,
  LOST_ANSWER_RETRY_MS,
  NoLongerOwed,
  stillOwed,
} from './policy.ts';
import type { AutoResumeCandidate, AutoResumeOutcome, AutoResumePorts, AutoResumeSettings } from './types.ts';

/** How one attempt at a ferret ended: an outcome, nothing owed any more, a wait before asking again, or the stop. */
type Attempt =
  | AutoResumeOutcome
  | { readonly kind: 'gone' }
  | { readonly kind: 'later'; readonly delayMs: number }
  | { readonly kind: 'aborted' };

/** Whether the job was told to stop (read through a call so a check after an await is not narrowed away). */
function stopped(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Brings back the ferrets a host restart took down.
 *
 * TWO STEPS, SEPARATED IN TIME. {@link record} runs the moment the daemon learns which sessions were
 * running when it was last down, and writes them to a ledger BEFORE anything is attempted: the host
 * can go down again mid-pass, and what is owed must survive that. {@link run} runs once the daemon is
 * serving and works the ledger off, removing each entry as it is dealt with, so a crash mid-pass
 * resumes the remainder rather than repeating or forgetting.
 *
 * IT USES THE ORDINARY REVIVE through the resumer port — the path a send takes — and never a second
 * way to relaunch a pane. What it adds is only the policy around that: which sessions are still owed
 * one, what they are told, how fast, and what a person is shown afterwards.
 *
 * A session is only ever resumed from `failed`. Anything a person did in the meantime — a revive,
 * a stop, a completion — leaves it in another status and is respected.
 */
export class AutoResumeService {
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly ports: AutoResumePorts,
    private readonly settings: AutoResumeSettings,
  ) {}

  /** Adds sessions to the durable ledger, one entry per session. */
  async record(found: readonly AutoResumeCandidate[]): Promise<void> {
    if (found.length === 0) return;
    const existing = await this.ports.ledger.read();
    const ids = new Set(found.map(candidate => candidate.id));
    await this.ports.ledger.write([...existing.filter(candidate => !ids.has(candidate.id)), ...found]);
  }
  /**
   * Works the ledger off. Answers what it did, or `undefined` when there was nothing to do.
   *
   * `signal` is the job's: when it aborts (the daemon is stopping) nothing more is asked or launched, the waits end at
   * once, and what was not dealt with stays in the ledger for the next boot.
   */
  async run(signal?: AbortSignal): Promise<AutoResumeSummary | undefined> {
    const owed = await this.ports.ledger.read();
    if (owed.length === 0) return undefined;
    // Off means off: the sessions stay as they are, and the ledger is cleared so that turning the
    // setting on later does not revive a reboot from days ago. A clear that FAILS (the disk is full or read-only)
    // fails the pass, which spends nothing, and leaves the entries: the declared window is the day `maxAgeMs` keeps
    // them (a later boot with the switch on resumes only entries younger than that), and the failure is reported.
    // A stop that interrupts the question is not a "no": the entries stay.
    const enabled = await this.ports.setting.enabled().catch((error: unknown) => {
      if (stopped(signal)) return undefined;
      throw error;
    });
    if (enabled === undefined) return undefined;
    if (!enabled) {
      await this.ports.ledger.write([]);
      return undefined;
    }
    const queue = [...freshCandidates(owed, this.ports.clock.nowMs(), this.settings.maxAgeMs)];
    const remaining = new Map(owed.map(candidate => [candidate.id, candidate]));
    for (const stale of owed) if (!queue.some(candidate => candidate.id === stale.id)) remaining.delete(stale.id);
    await this.persist(remaining);
    const resumed: string[] = [];
    const skipped: { sessionId: string; reason: string }[] = [];
    // A ferret whose answer was lost waits OUT of the queue, not in a worker: it holds no slot while it waits, and comes
    // back at the END of the queue when its time is up, so the ferrets still waiting their first turn are not held behind
    // it. The workers stay until the queue and the waiting are both empty.
    const lost = new Map<string, number>();
    const waiters: (() => void)[] = [];
    let waiting = 0;
    const wake = (): void => {
      for (const waiter of waiters.splice(0)) waiter();
    };
    signal?.addEventListener('abort', wake, { once: true });
    const retryLater = (candidate: AutoResumeCandidate, delayMs: number): void => {
      waiting += 1;
      void this.ports
        .sleep(delayMs, signal)
        .then(() => {
          if (!stopped(signal)) queue.push(candidate);
        })
        .catch(() => undefined)
        .finally(() => {
          waiting -= 1;
          wake();
        });
    };
    const workers = Math.min(this.settings.concurrency, queue.length);
    await Promise.all(
      Array.from({ length: workers }, async (_, worker) => {
        if (worker > 0 && !(await this.pause(worker * this.settings.staggerMs, signal))) return;
        for (;;) {
          if (stopped(signal)) return;
          const next = queue.shift();
          if (next === undefined) {
            if (waiting === 0) return;
            await new Promise<void>(resolve => waiters.push(resolve));
            continue;
          }
          const outcome = await this.attempt(next, signal, lost);
          if (outcome.kind === 'aborted') return;
          if (outcome.kind === 'later') retryLater(next, outcome.delayMs);
          else {
            remaining.delete(next.id);
            await this.persist(remaining);
            if (outcome.kind === 'resumed') resumed.push(next.id);
            if (outcome.kind === 'skipped') skipped.push({ sessionId: next.id, reason: outcome.reason });
          }
          if (queue.length > 0 && !(await this.pause(this.settings.staggerMs, signal))) return;
        }
      }),
    );
    if (resumed.length === 0 && skipped.length === 0) return undefined;
    const summary: AutoResumeSummary = { at: this.ports.clock.now(), resumed: resumed.length, skipped };
    await this.ports.summary.write(summary).catch(() => undefined);
    return summary;
  }

  /** Waits `ms`, answering whether it was the whole wait: `false` when the job's stop cut it short. */
  private async pause(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
    try {
      await this.ports.sleep(ms, signal);
      return !stopped(signal);
    } catch (error) {
      if (stopped(signal)) return false;
      throw error;
    }
  }

  private async attempt(
    candidate: AutoResumeCandidate,
    signal: AbortSignal | undefined,
    lost: Map<string, number>,
  ): Promise<Attempt> {
    if (stopped(signal)) return { kind: 'aborted' };
    const subject = await this.ports.roster.subject(candidate.id).catch(() => undefined);
    // Read fresh each time round, so a ferret stopped or resumed while its answer was being waited for is let go here.
    if (!stillOwed(subject) || subject === undefined) return { kind: 'gone' };
    const refused = await this.unavailable(candidate.id, signal, lost);
    if (refused?.kind === 'skipped') return await this.settle(candidate.id, refused);
    if (refused !== undefined) return refused;
    // The stop came while the last question was out: nothing is launched after it.
    if (stopped(signal)) return { kind: 'aborted' };
    const message = bootNotice(candidate.status, subject.mode);
    try {
      await this.ports.resumer.resume(candidate.id, message);
    } catch (error) {
      // Another path (the Warden's revive, a message sent to it, a person) brought it back between the check above and
      // the resume's own, under the ferret's queue: the resume REFUSED it as no longer owed and the ferret is up, which is
      // what this pass wanted. Standing down says nothing: a "skipped: stopped, resumed or ended by something else first"
      // line would read as a failure on a ferret that is running. Every other outcome is still told, `starting` included:
      // a launch that failed and could not stop its pane leaves the record `starting` with the resume rejected.
      if (error instanceof NoLongerOwed) {
        const now = await this.ports.roster.subject(candidate.id).catch(() => undefined);
        if (isUpElsewhere(now)) return { kind: 'gone' };
      }
      return await this.settle(candidate.id, { kind: 'skipped', reason: reasonOf(error) });
    }
    return await this.settle(candidate.id, { kind: 'resumed', notified: message !== undefined });
  }

  /** Why the ferret's runtime and login cannot serve it now: a skip, a wait before asking again, or the stop; `undefined` when they can. */
  private async unavailable(
    id: string,
    signal: AbortSignal | undefined,
    lost: Map<string, number>,
  ): Promise<Exclude<Attempt, { kind: 'resumed' | 'gone' }> | undefined> {
    try {
      const reason = await this.ports.availability.unavailable(id);
      // A stop that cut the question short can arrive as a reason: it is the stop, not a refusal.
      if (stopped(signal)) return { kind: 'aborted' };
      return reason === undefined ? undefined : { kind: 'skipped', reason };
    } catch (error) {
      if (stopped(signal)) return { kind: 'aborted' };
      const tries = lost.get(id) ?? 0;
      const delayMs = error instanceof AnswerLost ? LOST_ANSWER_RETRY_MS[tries] : undefined;
      if (delayMs === undefined) return { kind: 'skipped', reason: reasonOf(error) };
      lost.set(id, tries + 1);
      return { kind: 'later', delayMs };
    }
  }

  private async settle(id: string, outcome: AutoResumeOutcome): Promise<AutoResumeOutcome> {
    await this.ports.journal.record(id, outcome).catch(() => undefined);
    return outcome;
  }

  /** Serialized, because two workers finish at arbitrary moments and the last write must be the latest. */
  private async persist(remaining: ReadonlyMap<string, AutoResumeCandidate>): Promise<void> {
    const snapshot = [...remaining.values()];
    this.writes = this.writes.then(() => this.ports.ledger.write(snapshot).catch(() => undefined));
    await this.writes;
  }
}
