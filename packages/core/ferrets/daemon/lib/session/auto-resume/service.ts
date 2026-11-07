import type { AutoResumeSummary } from '@ferretry/protocol';
import { bootNotice, freshCandidates, stillOwed } from './policy.ts';
import type { AutoResumeCandidate, AutoResumeOutcome, AutoResumePorts, AutoResumeSettings } from './types.ts';

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

  /** Works the ledger off. Answers what it did, or `undefined` when there was nothing to do. */
  async run(): Promise<AutoResumeSummary | undefined> {
    const owed = await this.ports.ledger.read();
    if (owed.length === 0) return undefined;
    // Off means off: the sessions stay as they are, and the ledger is cleared so that turning the
    // setting on later does not revive a reboot from days ago.
    if (!(await this.ports.setting.enabled())) {
      await this.ports.ledger.write([]);
      return undefined;
    }
    const queue = [...freshCandidates(owed, this.ports.clock.nowMs(), this.settings.maxAgeMs)];
    const remaining = new Map(owed.map(candidate => [candidate.id, candidate]));
    for (const stale of owed) if (!queue.some(candidate => candidate.id === stale.id)) remaining.delete(stale.id);
    await this.persist(remaining);
    const resumed: string[] = [];
    const skipped: { sessionId: string; reason: string }[] = [];
    const workers = Math.min(this.settings.concurrency, queue.length);
    await Promise.all(
      Array.from({ length: workers }, async (_, worker) => {
        if (worker > 0) await this.ports.sleep(worker * this.settings.staggerMs);
        for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
          const outcome = await this.attempt(next);
          remaining.delete(next.id);
          await this.persist(remaining);
          if (outcome?.kind === 'resumed') resumed.push(next.id);
          if (outcome?.kind === 'skipped') skipped.push({ sessionId: next.id, reason: outcome.reason });
          if (queue.length > 0) await this.ports.sleep(this.settings.staggerMs);
        }
      }),
    );
    if (resumed.length === 0 && skipped.length === 0) return undefined;
    const summary: AutoResumeSummary = { at: this.ports.clock.now(), resumed: resumed.length, skipped };
    await this.ports.summary.write(summary).catch(() => undefined);
    return summary;
  }

  private async attempt(candidate: AutoResumeCandidate): Promise<AutoResumeOutcome | undefined> {
    const subject = await this.ports.roster.subject(candidate.id).catch(() => undefined);
    if (!stillOwed(subject) || subject === undefined) return undefined;
    const unavailable = await this.ports.availability.unavailable(candidate.id).catch(reasonOf);
    if (unavailable !== undefined) return await this.settle(candidate.id, { kind: 'skipped', reason: unavailable });
    const message = bootNotice(candidate.status, subject.mode);
    try {
      await this.ports.resumer.resume(candidate.id, message);
    } catch (error) {
      return await this.settle(candidate.id, { kind: 'skipped', reason: reasonOf(error) });
    }
    return await this.settle(candidate.id, { kind: 'resumed', notified: message !== undefined });
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
