// THE PHONE OUTBOX, TICK ONE.
//
// Every message a person sends first lands here — on this device, durably — before any request is made. A
// message typed with no connection ("thank you", mid-reconnect, on a train) is therefore kept, shows ✓ and
// "waiting for connection", and goes out by itself when the machine answers (docs/message-delivery.md, "The
// outbox"). The ticks that follow belong to the daemon's queue and ledger under the SAME id.
//
// IDEMPOTENT BY ID. The entry's id is the request id the send travels under, and the daemon reuses it as
// the queue message id and answers a repeat from its first record. So an outbox that is unsure whether a
// request arrived (a lost answer, a reload mid-send) just sends again: a retry never types a message twice.
//
// IN ORDER, PER SESSION. A session's entries leave one at a time, oldest first, and an entry that cannot
// leave holds the ones behind it: the reader typed them in that order, and the ferret should read them so.
// Sessions are independent of each other.

import type { SharedDraftSent } from '@ferretry/protocol';
import { withReferences } from './agenda-reply.ts';
import { attachmentErrorMessage } from './attachments.ts';
import { carrierDelivery } from './relay-carrier.ts';

/** A file chosen for a message that has not been uploaded yet; it goes up as part of the drain, before the send. */
export interface OutboxFile {
  readonly name: string;
  readonly type: string;
  readonly blob: Blob;
}

export interface OutboxEntry {
  /** The send's id AND its request id: the daemon's idempotency key and, once queued, its message id. */
  readonly id: string;
  readonly daemonId: string;
  readonly sessionId: string;
  readonly message: string;
  /**
   * The Agenda items this message is about (the composer's "re" chips), sent as the `!A3` prefix the daemon reads.
   * Kept apart from the words so an edit shows only what was typed, and added on EVERY attempt — a message that
   * leaves after a reload or a reconnect is still about the item it was typed for.
   */
  readonly references?: readonly string[];
  /** Files already on the daemon. */
  readonly attachmentIds: readonly string[];
  /** Files still to upload; emptied (into `attachmentIds`) as each one goes up. */
  readonly files: readonly OutboxFile[];
  /** The explicit "send now" — the daemon's `now` flag; it keeps the message's place in the order. */
  readonly now: boolean;
  readonly createdAt: string;
  /** Orders entries made in the same millisecond, and survives a reload. */
  readonly seq: number;
  /** Why it still waits, in plain words; absent before the first attempt. */
  readonly reason?: string;
  /** A machine answered "no" (not "I can't be reached"): the person must edit or cancel it. */
  readonly refused?: true;
  /**
   * What this message takes out of the owner's shared draft, sent WITH it so the daemon clears exactly
   * that once the message lands — however much later, and whether or not a composer is still open.
   */
  readonly sharedDraft?: SharedDraftSent;
}

/** Where entries are kept. IndexedDB in a browser; a Map in a test. */
export interface OutboxBackend {
  all(): Promise<readonly OutboxEntry[]>;
  put(entry: OutboxEntry): Promise<void>;
  delete(id: string): Promise<void>;
}

export class MemoryOutboxBackend implements OutboxBackend {
  readonly #entries = new Map<string, OutboxEntry>();
  async all(): Promise<readonly OutboxEntry[]> {
    return [...this.#entries.values()];
  }
  async put(entry: OutboxEntry): Promise<void> {
    this.#entries.set(entry.id, entry);
  }
  async delete(id: string): Promise<void> {
    this.#entries.delete(id);
  }
}

/** What the outbox needs from a machine: send under an id, and upload one file to a session. */
export interface OutboxSender {
  send(
    sessionId: string,
    input: {
      readonly message: string;
      readonly attachmentIds?: string[];
      readonly now?: boolean;
      readonly sharedDraft?: SharedDraftSent;
    },
    requestId: string,
  ): Promise<unknown>;
  upload(sessionId: string, file: OutboxFile): Promise<string>;
}

/** The machine's sender, or `null` when this browser has no way to dial it right now. */
export type OutboxResolve = (daemonId: string) => Promise<OutboxSender | null>;

/** How one `submit` ended, for a composer that wants to say something about it. */
export type OutboxOutcome =
  | { readonly kind: 'sent'; readonly result: unknown }
  | { readonly kind: 'waiting'; readonly reason: string }
  | { readonly kind: 'refused'; readonly reason: string; readonly error: unknown };

/** A way to send ONE entry other than the machine's own client — the composer's, which carries its reference prefix. */
export interface OutboxVia {
  readonly id?: string;
  readonly send: OutboxSender['send'];
}

export type OutboxChange = 'edited' | 'cancelled' | 'elsewhere';

export const WAITING_REASON = 'waiting for connection';

const statusOf = (error: unknown): number | undefined => {
  let current = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    const status = (current as { readonly status?: unknown }).status;
    if (typeof status === 'number') return status;
    current = current.cause;
  }
  return undefined;
};

/** What a request that never got an answer throws: the typed client's transport error, a deadline. */
const NETWORK_ERROR_NAMES: ReadonlySet<string> = new Set(['FyTransportError', 'AbortError', 'TimeoutError']);

/**
 * A bare `fetch` that never reached the machine rejects with a `TypeError` whose words each browser picks:
 * Chromium's "Failed to fetch", Firefox's "NetworkError when attempting to fetch resource.", WebKit's "Load
 * failed". ONLY those count as offline: any other `TypeError` is a bug in this app, and treating it as "no
 * connection" retried it every few seconds forever behind a calm "waiting for connection".
 */
const FETCH_NETWORK_FAILURE = /^(?:failed to fetch|networkerror when attempting to fetch resource\.?|load failed)$/iu;

/**
 * A failure that says nothing about the message itself: no carrier, a timeout, a machine that is down or
 * busy. Everything else is an answer — the daemon read the message and said no, or this app failed — and
 * waiting would not help, so it is shown rather than retried.
 */
const isWaitingFailure = (error: unknown): boolean => {
  if (carrierDelivery(error) !== undefined) return true;
  const status = statusOf(error);
  if (status !== undefined) return status === 408 || status === 429 || status >= 500;
  if (!(error instanceof Error)) return false;
  if (NETWORK_ERROR_NAMES.has(error.name)) return true;
  return error.name === 'TypeError' && FETCH_NETWORK_FAILURE.test(error.message.trim());
};

const reasonOf = (error: unknown): string =>
  error instanceof Error && error.message !== '' ? error.message : 'the machine refused it';

const order = (a: OutboxEntry, b: OutboxEntry): number =>
  a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.seq - b.seq;

const sessionKey = (daemonId: string, sessionId: string): string => `${daemonId}\u0000${sessionId}`;

export interface SendOutboxOptions {
  readonly backend: OutboxBackend;
  readonly resolve: OutboxResolve;
  readonly mintId: () => string;
  readonly now?: () => number;
  /** How long to wait before trying the entries that could not leave again. */
  readonly retryAfterMs?: number;
  readonly setTimer?: (run: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

export interface OutboxEnqueue {
  readonly daemonId: string;
  readonly sessionId: string;
  readonly message: string;
  readonly attachmentIds?: readonly string[];
  readonly files?: readonly OutboxFile[];
  readonly now?: boolean;
  /** The Agenda items it is about; see {@link OutboxEntry.references}. */
  readonly references?: readonly string[];
  /** See {@link OutboxEntry.sharedDraft}. */
  readonly sharedDraft?: SharedDraftSent;
}

export class SendOutbox {
  readonly #backend: OutboxBackend;
  readonly #resolve: OutboxResolve;
  readonly #mintId: () => string;
  readonly #clock: () => number;
  readonly #retryAfter: number;
  readonly #setTimer: (run: () => void, ms: number) => unknown;
  readonly #clearTimer: (handle: unknown) => void;
  readonly #entries = new Map<string, OutboxEntry>();
  readonly #listeners = new Set<() => void>();
  /** The drain running for a session, so a second ask joins it instead of racing it. */
  readonly #flights = new Map<string, Promise<void>>();
  /** The id each session's drain is sending right now. */
  readonly #sending = new Map<string, string>();
  readonly #outcomes = new Map<string, OutboxOutcome>();
  #snapshot: readonly OutboxEntry[] = [];
  #seq = 0;
  #timer: unknown = null;
  #loaded: Promise<void> | null = null;

  constructor(options: SendOutboxOptions) {
    this.#backend = options.backend;
    this.#resolve = options.resolve;
    this.#mintId = options.mintId;
    this.#clock = options.now ?? Date.now;
    this.#retryAfter = options.retryAfterMs ?? 20_000;
    this.#setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
    this.#clearTimer = options.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** Reads what a previous page left behind. Safe to call twice; a backend that cannot be read is an empty outbox. */
  load(): Promise<void> {
    this.#loaded ??= this.#backend.all().then(
      stored => {
        for (const entry of stored) {
          if (this.#entries.has(entry.id)) continue;
          this.#entries.set(entry.id, entry);
          this.#seq = Math.max(this.#seq, entry.seq);
        }
        this.#publish();
        this.#scheduleRetry();
      },
      () => undefined,
    );
    return this.#loaded;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** Every entry, oldest first. The same array until something changes, so it can feed `useSyncExternalStore`. */
  snapshot = (): readonly OutboxEntry[] => this.#snapshot;

  entriesFor(daemonId: string, sessionId?: string): readonly OutboxEntry[] {
    return this.#snapshot.filter(
      entry => entry.daemonId === daemonId && (sessionId === undefined || entry.sessionId === sessionId),
    );
  }

  /** Writes the message to this device and returns. Nothing is requested until {@link submit} or {@link drain}. */
  async enqueue(input: OutboxEnqueue): Promise<OutboxEntry> {
    return (await this.#enqueue(input)).entry;
  }

  /** Enqueues, and says whether the entry reached this device's storage or lives only in this tab. */
  async #enqueue(input: OutboxEnqueue): Promise<{ readonly entry: OutboxEntry; readonly stored: boolean }> {
    await this.load();
    this.#seq += 1;
    const entry: OutboxEntry = {
      id: this.#mintId(),
      daemonId: input.daemonId,
      sessionId: input.sessionId,
      message: input.message,
      ...(input.references === undefined || input.references.length === 0 ? {} : { references: [...input.references] }),
      attachmentIds: [...(input.attachmentIds ?? [])],
      files: [...(input.files ?? [])],
      now: input.now === true,
      ...(input.sharedDraft === undefined ? {} : { sharedDraft: input.sharedDraft }),
      createdAt: new Date(this.#clock()).toISOString(),
      seq: this.#seq,
    };
    this.#entries.set(entry.id, entry);
    this.#publish();
    return { entry, stored: await this.#persist(entry) };
  }

  /** Enqueues, drains the session and says how THIS entry ended. */
  async submit(
    input: OutboxEnqueue,
    via?: OutboxVia,
  ): Promise<{ readonly entry: OutboxEntry; readonly outcome: OutboxOutcome; readonly stored: boolean }> {
    const { entry, stored } = await this.#enqueue(input);
    await this.drain(entry.daemonId, entry.sessionId, via === undefined ? undefined : { id: entry.id, send: via.send });
    const outcome = this.#outcomes.get(entry.id) ?? { kind: 'waiting', reason: WAITING_REASON };
    this.#outcomes.delete(entry.id);
    return { entry, outcome, stored };
  }

  /** Sends one session's entries in order, stopping at the first that cannot leave. */
  drain(daemonId: string, sessionId: string, via?: OutboxVia): Promise<void> {
    const key = sessionKey(daemonId, sessionId);
    const running = this.#flights.get(key);
    if (running !== undefined) return running;
    const flight = this.#drainSession(daemonId, sessionId, via).finally(() => {
      this.#flights.delete(key);
      this.#scheduleRetry();
    });
    this.#flights.set(key, flight);
    return flight;
  }

  /** Tries every session that has something waiting. */
  async drainAll(): Promise<void> {
    await this.load();
    const sessions = new Map<string, OutboxEntry>();
    for (const entry of this.#snapshot) sessions.set(sessionKey(entry.daemonId, entry.sessionId), entry);
    await Promise.all([...sessions.values()].map(entry => this.drain(entry.daemonId, entry.sessionId)));
  }

  /** Tries only one machine's sessions — what a reconnect of that machine asks for. */
  async drainDaemon(daemonId: string): Promise<void> {
    await this.load();
    const sessions = new Set(this.entriesFor(daemonId).map(entry => entry.sessionId));
    await Promise.all([...sessions].map(sessionId => this.drain(daemonId, sessionId)));
  }

  /** Changes an entry's words while it is still on this device. `elsewhere`: it has left; ask the daemon's queue. */
  async edit(id: string, text: string): Promise<OutboxChange> {
    const entry = await this.#settled(id);
    if (entry === undefined) return 'elsewhere';
    const { reason: _reason, refused: _refused, ...rest } = entry;
    const next: OutboxEntry = { ...rest, message: text };
    this.#entries.set(id, next);
    this.#publish();
    await this.#persist(next);
    this.#scheduleRetry();
    return 'edited';
  }

  /** Takes an entry back before it has left. `elsewhere`: it has left; ask the daemon's queue. */
  async cancel(id: string): Promise<OutboxChange> {
    const entry = await this.#settled(id);
    if (entry === undefined) return 'elsewhere';
    this.#entries.delete(id);
    this.#publish();
    await this.#backend.delete(id).catch(() => undefined);
    return 'cancelled';
  }

  has(id: string): boolean {
    return this.#entries.has(id);
  }

  stop(): void {
    if (this.#timer !== null) this.#clearTimer(this.#timer);
    this.#timer = null;
  }

  /** The entry once any send of it that is in flight has finished — an edit must not race its own request. */
  async #settled(id: string): Promise<OutboxEntry | undefined> {
    await this.load();
    const entry = this.#entries.get(id);
    if (entry === undefined) return undefined;
    const flight = this.#flights.get(sessionKey(entry.daemonId, entry.sessionId));
    if (flight !== undefined && this.#sending.get(sessionKey(entry.daemonId, entry.sessionId)) === id) await flight;
    return this.#entries.get(id);
  }

  async #drainSession(daemonId: string, sessionId: string, via?: OutboxVia): Promise<void> {
    const key = sessionKey(daemonId, sessionId);
    await this.load();
    for (;;) {
      const next = this.#snapshot.find(entry => entry.daemonId === daemonId && entry.sessionId === sessionId);
      if (next === undefined) return;
      if (next.refused === true) return;
      this.#sending.set(key, next.id);
      let proceed: boolean;
      try {
        proceed = await this.#leave(next, via);
      } finally {
        this.#sending.delete(key);
      }
      if (!proceed) return;
    }
  }

  /** One entry's way out: upload its files, send it, forget it. `false` stops the session's drain. */
  async #leave(entry: OutboxEntry, via?: OutboxVia): Promise<boolean> {
    let sender: OutboxSender | null;
    try {
      sender = await this.#resolve(entry.daemonId);
    } catch {
      sender = null;
    }
    const viaThis = via !== undefined && via.id === entry.id;
    if (sender === null && (!viaThis || entry.files.length > 0))
      return await this.#hold(entry, { kind: 'waiting', reason: WAITING_REASON });
    let current = entry;
    for (const file of entry.files) {
      try {
        const attachmentId = await (sender as OutboxSender).upload(entry.sessionId, file);
        current = {
          ...current,
          attachmentIds: [...current.attachmentIds, attachmentId],
          files: current.files.filter(candidate => candidate !== file),
        };
        // Written before the send: a reload after this must not upload the same file again.
        if (this.#entries.has(entry.id)) {
          this.#entries.set(entry.id, current);
          await this.#persist(current);
        }
      } catch (error) {
        return await this.#hold(
          current,
          isWaitingFailure(error)
            ? { kind: 'waiting', reason: `${WAITING_REASON} — ${file.name} is not uploaded yet` }
            : {
                kind: 'refused',
                reason: `${file.name} could not be uploaded: ${attachmentErrorMessage(error)}`,
                error,
              },
        );
      }
    }
    try {
      const result = await (viaThis ? via : (sender as OutboxSender)).send(
        entry.sessionId,
        {
          message: withReferences(current.message, current.references ?? []),
          ...(current.attachmentIds.length === 0 ? {} : { attachmentIds: [...current.attachmentIds] }),
          ...(current.now ? { now: true } : {}),
          ...(current.sharedDraft === undefined ? {} : { sharedDraft: current.sharedDraft }),
        },
        current.id,
      );
      this.#entries.delete(current.id);
      this.#outcomes.set(current.id, { kind: 'sent', result });
      this.#publish();
      await this.#backend.delete(current.id).catch(() => undefined);
      return true;
    } catch (error) {
      return await this.#hold(
        current,
        isWaitingFailure(error)
          ? { kind: 'waiting', reason: WAITING_REASON }
          : { kind: 'refused', reason: reasonOf(error), error },
      );
    }
  }

  /** Keeps an entry that could not leave, with the reason it says. Always `false`: the drain stops here. */
  async #hold(entry: OutboxEntry, outcome: Exclude<OutboxOutcome, { kind: 'sent' }>): Promise<false> {
    this.#outcomes.set(entry.id, outcome);
    const live = this.#entries.get(entry.id);
    if (live === undefined) return false;
    const next: OutboxEntry = {
      ...live,
      attachmentIds: entry.attachmentIds,
      files: entry.files,
      reason: outcome.reason,
      ...(outcome.kind === 'refused' ? { refused: true as const } : {}),
    };
    this.#entries.set(entry.id, next);
    this.#publish();
    await this.#persist(next);
    return false;
  }

  /** Writes an entry to this device's storage; `false` when storage refused it and it lives only in this tab. */
  async #persist(entry: OutboxEntry): Promise<boolean> {
    return await this.#backend.put(entry).then(
      () => true,
      () => false,
    );
  }

  #publish(): void {
    this.#snapshot = [...this.#entries.values()].sort(order);
    for (const listener of this.#listeners) listener();
  }

  /** While anything waits for a connection, look again after a while: a reconnect signal can be missed. */
  #scheduleRetry(): void {
    if (this.#timer !== null) return;
    if (!this.#snapshot.some(entry => entry.refused !== true)) return;
    this.#timer = this.#setTimer(() => {
      this.#timer = null;
      void this.drainAll();
    }, this.#retryAfter);
  }
}
