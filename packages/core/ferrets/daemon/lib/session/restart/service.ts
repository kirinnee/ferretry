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
 *
 * THE DRAIN IS CHEAP, because it runs on a short tick for as long as the daemon does. The queue is held in
 * memory once it has been read (every write goes through this service), so an empty queue costs no read at
 * all; a pass looks up only the ferrets that are queued, never the whole fleet; and a ferret the inventory
 * refused is not asked again on every tick — that is a whole migrate preflight, a transcript read included —
 * but after a backoff, or as soon as its turn moves. Before 4.114 one entry stuck behind a long-running
 * child made every tick read, parse and project all ~500 sessions on the box and stalled its loop.
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
  /**
   * What the in-flight gate reads of the ferret's own record, as one comparable value. A refused restart is
   * retried at once when it changes, and only after a backoff while it does not.
   */
  readonly revision?: string | undefined;
}

/** Thrown by {@link RestartPorts.restart} when the in-flight inventory refuses: work a restart would lose. */
export class RestartBusy extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RestartBusy';
  }
}

export interface RestartPorts {
  /** Every ferret: for a person's request, which may name any of them. */
  subjects(): Promise<readonly RestartSubject[]>;
  /** One ferret, or `undefined` when it is gone: all the drain ever reads. */
  subject(id: string): Promise<RestartSubject | undefined>;
  /** The sections a launch now would change for this ferret, read fresh — empty when it is current. */
  outdated(id: string): Promise<readonly LaunchInstructionSectionId[]>;
  /** The same-login resume migrate, without force. Throws {@link RestartBusy} when the inventory refuses. */
  restart(id: string, requestedBy?: string): Promise<void>;
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

/** The first wait after the inventory refuses a queued restart; it doubles with each refusal of the same record. */
export const RESTART_RETRY_BASE_MS = 10_000;
/** The longest a refused restart waits while nothing about the ferret changes. */
export const RESTART_RETRY_CAP_MS = 120_000;

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** When a refused restart may be asked again, and of which record. */
interface RetryAfter {
  readonly revision: string | undefined;
  readonly refusals: number;
  readonly atMs: number;
}

export class RestartService {
  readonly #remembered = new Map<string, RestartResult>();
  /** The queue as it was last read or written; `undefined` until the first read. */
  #queue: readonly RestartQueueEntry[] | undefined;
  readonly #retries = new Map<string, RetryAfter>();
  #draining: Promise<void> | undefined;
  /** Serialises every read-modify-write of the queue. */
  #chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly ports: RestartPorts) {}

  #locked<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#chain.then(work, work);
    this.#chain = next.catch(() => undefined);
    return next;
  }

  async #entries(): Promise<readonly RestartQueueEntry[]> {
    this.#queue ??= await this.ports.queue.load();
    return this.#queue;
  }

  /** Writes the queue only when it changed: a pass that kept everything as it was writes nothing. */
  async #save(entries: readonly RestartQueueEntry[]): Promise<void> {
    const before = await this.#entries();
    if (JSON.stringify(before) === JSON.stringify(entries)) return;
    await this.ports.queue.save(entries);
    this.#queue = entries;
    for (const id of this.#retries.keys()) if (!entries.some(entry => entry.id === id)) this.#retries.delete(id);
  }

  #nowMs(): number {
    return Date.parse(this.ports.now());
  }

  /** Every outdated running ferret and every waiting restart. */
  async status(): Promise<RestartStatus> {
    const subjects = await this.ports.subjects();
    const outdated: RestartStatus['outdated'][number][] = [];
    for (const subject of subjects.filter(candidate => candidate.running)) {
      const sections = await this.ports.outdated(subject.id).catch(() => []);
      if (sections.length > 0) outdated.push({ id: subject.id, ...named(subject), sections: [...sections] });
    }
    return { outdated, queued: [...(await this.#entries())] };
  }

  /** Clears the queue; answers how many entries it held. */
  async cancel(): Promise<{ readonly cancelled: number }> {
    return await this.#locked(async () => {
      const entries = await this.#entries();
      await this.#save([]);
      return { cancelled: entries.length };
    });
  }

  /** Restarts what can be restarted now and queues the rest; the same request id answers the same result. */
  async restart(request: RestartRequest, requestId?: string, requestedBy?: string): Promise<RestartResult> {
    const known = requestId === undefined ? undefined : this.#remembered.get(requestId);
    if (known !== undefined) return known;
    const result = await this.#locked(async () => await this.#run(request, requestedBy));
    if (requestId !== undefined) {
      this.#remembered.set(requestId, result);
      const oldest = this.#remembered.keys().next();
      if (this.#remembered.size > REMEMBERED_REQUESTS && !oldest.done) this.#remembered.delete(oldest.value);
    }
    return result;
  }

  async #run(request: RestartRequest, requestedBy?: string): Promise<RestartResult> {
    const subjects = await this.ports.subjects();
    const byId = new Map(subjects.map(subject => [subject.id, subject]));
    const restarted: RestartResult['restarted'][number][] = [];
    const queued: RestartQueued[] = [];
    const skipped: RestartResult['skipped'][number][] = [];
    const failed: RestartResult['failed'][number][] = [];
    const waiting = new Map((await this.#entries()).map(entry => [entry.id, entry]));

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
      // A person asking again starts the ferret's backoff over: the drain may try it at its next tick.
      this.#retries.delete(subject.id);
      const wait = (reason: RestartQueueReason, detail?: string): void => {
        queued.push({ id: subject.id, ...named(subject), reason, ...(detail === undefined ? {} : { detail }) });
        waiting.set(subject.id, {
          id: subject.id,
          ...named(subject),
          since: waiting.get(subject.id)?.since ?? this.ports.now(),
          reason,
          onlyIfOutdated: request.scope === 'outdated',
          ...(requestedBy === undefined ? {} : { requestedBy }),
        });
      };
      if (subject.id === request.caller) wait('own-session');
      else if (!subject.idle) wait('mid-turn');
      else {
        try {
          await this.ports.restart(subject.id, requestedBy);
          restarted.push({ id: subject.id, ...named(subject) });
          waiting.delete(subject.id);
        } catch (error) {
          if (error instanceof RestartBusy) wait('in-flight', error.message);
          else failed.push({ id: subject.id, ...named(subject), reason: message(error) });
        }
      }
    }
    await this.#save([...waiting.values()]);
    return { restarted, queued, skipped, failed };
  }

  /**
   * One pass over the queue: each waiting ferret that is now idle is restarted, unless the inventory still
   * refuses (it stays queued). An entry for a ferret that is gone, stopped, or — for an outdated-only entry —
   * current again is dropped. Overlapping calls share one pass, and an empty queue answers without a read.
   */
  drain(): Promise<void> {
    if (this.#queue?.length === 0 && this.#draining === undefined) return Promise.resolve();
    this.#draining ??= this.#locked(async () => await this.#drain()).finally(() => {
      this.#draining = undefined;
    });
    return this.#draining;
  }

  async #drain(): Promise<void> {
    const entries = await this.#entries();
    if (entries.length === 0) return;
    const kept: RestartQueueEntry[] = [];
    for (const entry of entries) {
      // Only the queued ferret is read: the drain never needs the rest of the fleet.
      const subject = await this.ports.subject(entry.id).catch(() => undefined);
      if (subject === undefined || !subject.running) continue;
      if (!subject.idle) {
        kept.push(entry);
        continue;
      }
      // Refused before, and nothing the gate reads has moved since: ask again only once the backoff is over.
      const retry = this.#retries.get(entry.id);
      if (retry !== undefined && retry.revision === subject.revision && this.#nowMs() < retry.atMs) {
        kept.push(entry);
        continue;
      }
      if (entry.onlyIfOutdated && (await this.ports.outdated(entry.id).catch(() => ['tools' as const])).length === 0)
        continue;
      try {
        await this.ports.restart(entry.id, entry.requestedBy);
        this.#retries.delete(entry.id);
      } catch (error) {
        if (error instanceof RestartBusy) {
          kept.push({ ...entry, reason: 'in-flight' });
          this.#refused(entry.id, subject.revision, retry);
        } else await this.ports.gaveUp(entry.id, message(error)).catch(() => undefined);
      }
    }
    await this.#save(kept);
  }

  /** Backs a refused restart off: doubling while the ferret's record stands still, from the start once it moves. */
  #refused(id: string, revision: string | undefined, previous: RetryAfter | undefined): void {
    const refusals = previous !== undefined && previous.revision === revision ? previous.refusals + 1 : 1;
    const waitMs = Math.min(RESTART_RETRY_BASE_MS * 2 ** (refusals - 1), RESTART_RETRY_CAP_MS);
    this.#retries.set(id, { revision, refusals, atMs: this.#nowMs() + waitMs });
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
