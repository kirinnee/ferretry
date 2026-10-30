/**
 * Restarting ferrets whose instructions are out of date (docs/launch-settings.md, "Restarting ferrets whose
 * instructions are out of date").
 *
 * A restart is the same-login migrate with the conversation resumed — `RestartPorts.restart` — and it is
 * NEVER forced past the in-flight inventory. So a ferret that is busy is not restarted: it is QUEUED, and
 * restarted by {@link RestartService.drain} at its next idle moment (its turn is yours, or it declared a wait),
 * once the inventory also agrees. The queue is durable, so a daemon restart does not lose it.
 *
 * Total on the failure path of one ferret: a ferret whose restart fails does not stop the others.
 */

import type {
  LaunchInstructionSectionId,
  RestartQueued,
  RestartQueueEntry,
  RestartQueueReason,
  RestartRequest,
  RestartResult,
  RestartStatus,
} from '@ferretry/protocol';

/** One ferret as the restart sees it. */
export interface RestartSubject {
  readonly id: string;
  readonly name?: string | undefined;
  /** A live process a restart could replace; a finished or stopped ferret is not restarted. */
  readonly running: boolean;
  /** At a your-turn or in a declared wait: the only moments a restart is attempted. */
  readonly idle: boolean;
}

/** Thrown by {@link RestartPorts.restart} when the in-flight inventory refuses: work a restart would lose. */
export class RestartBusy extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RestartBusy';
  }
}

export interface RestartPorts {
  subjects(): Promise<readonly RestartSubject[]>;
  /** The sections a launch now would change for this ferret, read fresh — empty when it is current. */
  outdated(id: string): Promise<readonly LaunchInstructionSectionId[]>;
  /** The same-login resume migrate, without force. Throws {@link RestartBusy} when the inventory refuses. */
  restart(id: string): Promise<void>;
  /** Journals that a queued restart gave up, so the ferret's history says why. */
  gaveUp(id: string, reason: string): Promise<void>;
  readonly queue: {
    load(): Promise<readonly RestartQueueEntry[]>;
    save(entries: readonly RestartQueueEntry[]): Promise<void>;
  };
  now(): string;
}

/** How many answered requests are remembered, so a retried POST is answered, not run again. */
const REMEMBERED_REQUESTS = 64;

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export class RestartService {
  readonly #remembered = new Map<string, RestartResult>();
  #draining: Promise<void> | undefined;
  /** Serialises every read-modify-write of the queue. */
  #chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly ports: RestartPorts) {}

  #locked<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#chain.then(work, work);
    this.#chain = next.catch(() => undefined);
    return next;
  }

  /** Every outdated running ferret and every waiting restart. */
  async status(): Promise<RestartStatus> {
    const subjects = await this.ports.subjects();
    const outdated: RestartStatus['outdated'][number][] = [];
    for (const subject of subjects.filter(candidate => candidate.running)) {
      const sections = await this.ports.outdated(subject.id).catch(() => []);
      if (sections.length > 0) outdated.push({ id: subject.id, ...named(subject), sections: [...sections] });
    }
    return { outdated, queued: [...(await this.ports.queue.load())] };
  }

  /** Clears the queue; answers how many entries it held. */
  async cancel(): Promise<{ readonly cancelled: number }> {
    return await this.#locked(async () => {
      const entries = await this.ports.queue.load();
      await this.ports.queue.save([]);
      return { cancelled: entries.length };
    });
  }

  /** Restarts what can be restarted now and queues the rest; the same request id answers the same result. */
  async restart(request: RestartRequest, requestId?: string): Promise<RestartResult> {
    const known = requestId === undefined ? undefined : this.#remembered.get(requestId);
    if (known !== undefined) return known;
    const result = await this.#locked(async () => await this.#run(request));
    if (requestId !== undefined) {
      this.#remembered.set(requestId, result);
      const oldest = this.#remembered.keys().next();
      if (this.#remembered.size > REMEMBERED_REQUESTS && !oldest.done) this.#remembered.delete(oldest.value);
    }
    return result;
  }

  async #run(request: RestartRequest): Promise<RestartResult> {
    const subjects = await this.ports.subjects();
    const byId = new Map(subjects.map(subject => [subject.id, subject]));
    const restarted: RestartResult['restarted'][number][] = [];
    const queued: RestartQueued[] = [];
    const skipped: RestartResult['skipped'][number][] = [];
    const failed: RestartResult['failed'][number][] = [];
    const waiting = new Map((await this.ports.queue.load()).map(entry => [entry.id, entry]));

    const targets: RestartSubject[] = [];
    if (request.scope === 'ids') {
      for (const reference of request.ids ?? []) {
        const subject = byId.get(reference) ?? byName(subjects, reference);
        if (subject === undefined) skipped.push({ id: reference, reason: 'not-found' });
        else if (!subject.running) skipped.push({ id: subject.id, ...named(subject), reason: 'not-running' });
        else if (!targets.includes(subject)) targets.push(subject);
      }
    } else {
      for (const subject of subjects.filter(candidate => candidate.running)) {
        if (request.scope === 'all' || (await this.ports.outdated(subject.id).catch(() => [])).length > 0)
          targets.push(subject);
      }
    }

    for (const subject of targets) {
      const wait = (reason: RestartQueueReason, detail?: string): void => {
        queued.push({ id: subject.id, ...named(subject), reason, ...(detail === undefined ? {} : { detail }) });
        waiting.set(subject.id, {
          id: subject.id,
          ...named(subject),
          since: waiting.get(subject.id)?.since ?? this.ports.now(),
          reason,
          onlyIfOutdated: request.scope === 'outdated',
        });
      };
      if (subject.id === request.caller) wait('own-session');
      else if (!subject.idle) wait('mid-turn');
      else {
        try {
          await this.ports.restart(subject.id);
          restarted.push({ id: subject.id, ...named(subject) });
          waiting.delete(subject.id);
        } catch (error) {
          if (error instanceof RestartBusy) wait('in-flight', error.message);
          else failed.push({ id: subject.id, ...named(subject), reason: message(error) });
        }
      }
    }
    await this.ports.queue.save([...waiting.values()]);
    return { restarted, queued, skipped, failed };
  }

  /**
   * One pass over the queue: each waiting ferret that is now idle is restarted, unless the inventory still
   * refuses (it stays queued). An entry for a ferret that is gone, stopped, or — for an outdated-only entry —
   * current again is dropped. Overlapping calls share one pass.
   */
  drain(): Promise<void> {
    this.#draining ??= this.#locked(async () => await this.#drain()).finally(() => {
      this.#draining = undefined;
    });
    return this.#draining;
  }

  async #drain(): Promise<void> {
    const entries = await this.ports.queue.load();
    if (entries.length === 0) return;
    const byId = new Map((await this.ports.subjects()).map(subject => [subject.id, subject]));
    const kept: RestartQueueEntry[] = [];
    for (const entry of entries) {
      const subject = byId.get(entry.id);
      if (subject === undefined || !subject.running) continue;
      if (entry.onlyIfOutdated && (await this.ports.outdated(entry.id).catch(() => ['tools' as const])).length === 0)
        continue;
      if (!subject.idle) {
        kept.push(entry);
        continue;
      }
      try {
        await this.ports.restart(entry.id);
      } catch (error) {
        if (error instanceof RestartBusy) kept.push({ ...entry, reason: 'in-flight' });
        else await this.ports.gaveUp(entry.id, message(error)).catch(() => undefined);
      }
    }
    await this.ports.queue.save(kept);
  }
}

/** A ferret by callsign, the running one when a callsign was reused. */
const byName = (subjects: readonly RestartSubject[], reference: string): RestartSubject | undefined => {
  const wanted = reference.trim().replace(/^:/u, '').toLowerCase();
  const holders = subjects.filter(subject => subject.name?.toLowerCase() === wanted);
  return holders.find(subject => subject.running) ?? holders[0];
};

const named = (subject: { readonly name?: string | undefined }): { readonly name?: string } =>
  subject.name === undefined ? {} : { name: subject.name };
