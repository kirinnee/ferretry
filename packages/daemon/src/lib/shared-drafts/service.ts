/**
 * THE DAEMON'S SIDE OF THE SHARED DRAFT: the one sequencer every device's edits pass through.
 *
 * An edit names the revision it was made against. Everything that landed after that revision is still
 * in the remembered history, so the new one is transformed past each of those edits in turn, applied,
 * and handed back AS SEQUENCED — the form any device already at the previous revision can apply
 * without thinking. That is the whole concurrency story (`@ferretry/protocol` `shared-draft.ts` holds
 * the transform itself, shared with the app).
 *
 * MEMORY FIRST, DISK SOON AFTER. A draft is typed at keystroke rate, so it lives in memory and is
 * written {@link SHARED_DRAFT_WRITE_DELAY_MS} after it last changed; {@link SharedDraftService.flush}
 * writes whatever is still waiting when the daemon stops. A crash can lose at most that last second.
 *
 * A REVISION NUMBER MEANS SOMETHING ONLY WITHIN ONE GENERATION. Losing that second rolls `rev` back,
 * and the next edit then mints a revision number a device may already hold for different text. So
 * every load into memory mints a new generation, every edit names the one it was made in, and an edit
 * from another generation is refused as stale — the device reads the draft again and offers what it
 * typed back to the person, instead of splicing it into text it was never made for.
 *
 * A DRAFT IS NEVER LET GO OF UNWRITTEN. Eviction keeps it reachable until its write lands, a read in
 * the meantime takes it back, and a failed write is retried rather than dropped: otherwise the older
 * file would come back — and if a send had just emptied the draft, the sent words with it.
 *
 * NEVER IN THE JOURNAL. Nothing here touches session events, the transcript, search or the send queue:
 * a draft is the owner's unsent words, and no agent sees them until they are sent. Who may call this at
 * all is decided at the route (`runtime/mounts/shared-drafts.ts`).
 *
 * The edit path itself is synchronous once the draft is in memory, so two edits for one session can
 * never interleave half-way; loading is the only await, and it is shared by every caller that arrives
 * while it is in flight.
 */
import {
  applyTextOp,
  normalizeTextOp,
  SHARED_DRAFT_HISTORY_LIMIT,
  SHARED_DRAFT_ITEMS_BUDGET,
  SHARED_DRAFT_MAX_CHARS,
  SHARED_DRAFT_MAX_ITEMS,
  SHARED_DRAFT_SCHEMA_VERSION,
  type SharedDraftEdit,
  type SharedDraftEditResult,
  type SharedDraftItem,
  type SharedDraftSnapshot,
  type TextOp,
  TextOpError,
  sharedDraftFrameBytes,
  textOpBaseLength,
  transformTextOps,
} from '@ferretry/protocol';
import {
  type SharedDraftClock,
  SharedDraftError,
  type SharedDraftGenerationSource,
  type SharedDraftRepository,
  type SharedDraftScheduler,
  type SharedDraftSessionDirectory,
} from './types.ts';

/** How long after its last change a draft is written down, and how long before a failed write is first tried again. */
export const SHARED_DRAFT_WRITE_DELAY_MS = 1_000;
/** The longest a write that keeps failing waits between attempts: each failure doubles the wait up to this. */
export const SHARED_DRAFT_WRITE_RETRY_MAX_MS = 60_000;
/** Drafts held in memory at once; the least recently used is written down and let go. */
export const SHARED_DRAFT_MEMORY_LIMIT = 50;
/**
 * Characters the remembered history may insert in total. A count alone would let 200 whole-draft
 * pastes sit in memory per session; past this the oldest edits are forgotten, and a base that old is
 * simply stale.
 */
export const SHARED_DRAFT_HISTORY_MAX_CHARS = 256_000;

type Applied = SharedDraftEditResult['applied'];

/**
 * One sequenced edit, as every open composer for the session hears of it: the edit, where the draft
 * stands after it, and which composer made it (`origin`, opaque, whatever the caller passed), so the
 * one that made it can answer its own and everyone else can apply it.
 */
export interface SharedDraftChange {
  readonly applied: Applied;
  readonly epoch: number;
  readonly rev: number;
  readonly origin?: string;
}

export type SharedDraftListener = (change: SharedDraftChange) => void;

const ORIGIN_SEPARATOR = '\u0000';

/** The origin a stream's edit travels under: which stream sent it, and the id its composer gave it. */
export const sharedDraftOrigin = (stream: string, editId: string): string => `${stream}${ORIGIN_SEPARATOR}${editId}`;

/** The two halves of an origin, when it has them. */
export const splitSharedDraftOrigin = (
  origin: string | undefined,
): { readonly stream: string; readonly editId: string } | undefined => {
  const at = origin?.indexOf(ORIGIN_SEPARATOR) ?? -1;
  return origin === undefined || at === -1 ? undefined : { stream: origin.slice(0, at), editId: origin.slice(at + 1) };
};

interface LiveDraft {
  snapshot: SharedDraftSnapshot;
  /**
   * The edits after `historyStart`, oldest first; entry `i` moved the draft to `historyStart + i + 1`.
   * Each keeps its origin, so a composer that reconnects can recognise its own edit among what it missed.
   */
  history: SharedDraftChange[];
  /** Characters `history` inserts in total. */
  historyChars: number;
  /** The oldest revision an edit may still be based on. */
  historyStart: number;
  /** Not yet written down. */
  dirty: boolean;
  /** Writes in a row that failed; each one doubles the wait before the next attempt. */
  failures: number;
  timer?: { cancel(): void };
}

const identity = (text: string): TextOp => (text.length === 0 ? [] : [text.length]);

const insertedChars = (op: TextOp): number =>
  op.reduce<number>((total, component) => total + (typeof component === 'string' ? component.length : 0), 0);

const deletedChars = (op: TextOp): number =>
  op.reduce<number>((total, component) => total + (typeof component === 'number' && component < 0 ? -component : 0), 0);

export class SharedDraftService {
  readonly #live = new Map<string, LiveDraft>();
  /** Drafts let go of from memory whose newest state has not reached the disk yet. */
  readonly #unwritten = new Map<string, LiveDraft>();
  readonly #loading = new Map<string, Promise<LiveDraft>>();
  /** Writes in flight, so `flush` and a reload can wait for one a timer already started. */
  readonly #writes = new Set<Promise<void>>();
  /**
   * Sessions a read or an edit is between loading and finishing with, or an open composer is listening
   * to. Eviction skips them, so a draft is never let go of in the moment between being handed to an edit
   * and the edit changing it, nor while a composer is open on it.
   */
  readonly #holds = new Map<string, number>();
  readonly #listeners = new Map<string, Set<SharedDraftListener>>();
  /** Set by `close`: the daemon is stopping, so a failed write is not scheduled again. */
  #stopping = false;

  constructor(
    private readonly sessions: SharedDraftSessionDirectory,
    private readonly repository: SharedDraftRepository,
    private readonly clock: SharedDraftClock,
    private readonly scheduler: SharedDraftScheduler,
    private readonly generations: SharedDraftGenerationSource,
    private readonly memoryLimit: number = SHARED_DRAFT_MEMORY_LIMIT,
  ) {}

  /** The draft as it stands now; an empty one for a session nobody has typed into. */
  async read(sessionId: string): Promise<SharedDraftSnapshot> {
    return await this.#holding(sessionId, live => live.snapshot);
  }

  /**
   * The edits after `rev`, in order — what a composer that reconnects has missed — or `undefined` when
   * they can no longer be told edit by edit (another generation, a sent message, or older than the
   * remembered history), in which case the composer starts again from the whole draft.
   */
  async since(
    sessionId: string,
    position: { readonly generation: string; readonly epoch: number; readonly rev: number },
  ): Promise<readonly SharedDraftChange[] | undefined> {
    return await this.#holding(sessionId, live => {
      const current = live.snapshot;
      if (position.generation !== current.generation || position.epoch !== current.epoch) return undefined;
      if (position.rev < live.historyStart || position.rev > current.rev) return undefined;
      return live.history.slice(position.rev - live.historyStart);
    });
  }

  /** Hears every edit sequenced for this session from now on. Answers the way to stop. */
  subscribe(sessionId: string, listener: SharedDraftListener): () => void {
    const listeners = this.#listeners.get(sessionId) ?? new Set<SharedDraftListener>();
    listeners.add(listener);
    this.#listeners.set(sessionId, listeners);
    // An open composer holds its draft in memory: letting it go would mint a new generation under the
    // composer's feet, and its next keystroke would be refused for nothing.
    this.#hold(sessionId);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      listeners.delete(listener);
      if (listeners.size === 0 && this.#listeners.get(sessionId) === listeners) this.#listeners.delete(sessionId);
      this.#release(sessionId);
      this.#evict();
    };
  }

  /** Sequences one edit and answers with it as applied, and the draft after it. */
  async edit(sessionId: string, edit: SharedDraftEdit, origin?: string): Promise<SharedDraftEditResult> {
    return await this.#holding(sessionId, live => this.#apply(sessionId, live, edit, origin));
  }

  #apply(sessionId: string, live: LiveDraft, edit: SharedDraftEdit, origin: string | undefined): SharedDraftEditResult {
    const current = live.snapshot;
    // The same edit twice — sent again by a composer that reconnected before it heard the first landed —
    // is answered by the first and applied once. The composer already heard the first one, by its id.
    const editId = splitSharedDraftOrigin(origin)?.editId;
    if (editId !== undefined && edit.generation === current.generation) {
      const first = live.history.find(change => splitSharedDraftOrigin(change.origin)?.editId === editId);
      if (first !== undefined) return { applied: first.applied, snapshot: current };
    }
    if (edit.generation !== current.generation)
      throw new SharedDraftError(
        'stale',
        'this edit was made before the daemon last reloaded the draft, so its revision may name different text; read the draft again',
      );
    if (edit.epoch !== current.epoch)
      throw new SharedDraftError(
        'stale',
        `this edit was typed into a message that has since been sent (draft ${edit.epoch}, now ${current.epoch}); read the draft again`,
      );
    if (edit.base > current.rev || edit.base < live.historyStart)
      throw new SharedDraftError(
        'stale',
        `this edit is based on revision ${edit.base}, and only ${live.historyStart}–${current.rev} can still be merged; read the draft again`,
      );

    const text = this.#sequence(live, edit);
    // Measured before the text is built, so an oversized edit never costs the string it would make.
    if (current.text.length + insertedChars(text) - deletedChars(text) > SHARED_DRAFT_MAX_CHARS)
      throw new SharedDraftError('too-long', `a draft holds at most ${SHARED_DRAFT_MAX_CHARS} characters`);
    const nextText = applyTextOp(current.text, text);

    const removing = new Set(edit.remove ?? []);
    const removed = current.items.filter(item => removing.has(item.id)).map(item => item.id);
    const kept = current.items.filter(item => !removing.has(item.id));
    const added: SharedDraftItem[] = [];
    for (const item of edit.add ?? []) {
      if (kept.some(existing => existing.id === item.id) || added.some(existing => existing.id === item.id)) continue;
      added.push(item);
    }
    const items = [...kept, ...added];
    if (items.length > SHARED_DRAFT_MAX_ITEMS)
      throw new SharedDraftError('too-many-items', `a draft holds at most ${SHARED_DRAFT_MAX_ITEMS} files and places`);
    // Bounded by size too, so the whole set always fits one stream frame beside a part of the text.
    if (added.length > 0 && sharedDraftFrameBytes(items) > SHARED_DRAFT_ITEMS_BUDGET)
      throw new SharedDraftError('too-many-items', 'the files and places in this draft have names too long to share');

    const applied: Applied = {
      generation: current.generation,
      epoch: current.epoch,
      rev: current.rev + 1,
      text,
      add: added,
      remove: removed,
    };
    // A send that took everything with it ends this message: the next one starts a new epoch, so an
    // edit somebody typed into the old one can never land in it.
    const finished = edit.sent === true && nextText === '' && items.length === 0;
    live.snapshot = {
      v: SHARED_DRAFT_SCHEMA_VERSION,
      sessionId,
      generation: current.generation,
      epoch: finished ? current.epoch + 1 : current.epoch,
      rev: finished ? 0 : applied.rev,
      text: nextText,
      items,
      updatedAt: this.clock.now(),
    };
    const change: SharedDraftChange = {
      applied,
      epoch: live.snapshot.epoch,
      rev: live.snapshot.rev,
      ...(origin === undefined ? {} : { origin }),
    };
    if (finished) {
      live.history = [];
      live.historyChars = 0;
      live.historyStart = 0;
    } else {
      live.history.push(change);
      live.historyChars += insertedChars(text);
      while (
        live.history.length > SHARED_DRAFT_HISTORY_LIMIT ||
        (live.historyChars > SHARED_DRAFT_HISTORY_MAX_CHARS && live.history.length > 0)
      ) {
        const oldest = live.history.shift();
        live.historyChars -= oldest === undefined ? 0 : insertedChars(oldest.applied.text);
      }
      live.historyStart = applied.rev - live.history.length;
    }
    this.#schedule(live);
    for (const listener of [...(this.#listeners.get(sessionId) ?? [])]) {
      try {
        listener(change);
      } catch {
        // One composer's broken stream must not cost the edit, or any other composer its copy.
      }
    }
    return { applied, snapshot: live.snapshot };
  }

  /** Loads the draft and runs `work` on it while eviction is kept off it. */
  async #holding<T>(sessionId: string, work: (live: LiveDraft) => T): Promise<T> {
    this.#hold(sessionId);
    try {
      return work(await this.#draft(sessionId));
    } finally {
      this.#release(sessionId);
      this.#evict();
    }
  }

  #hold(sessionId: string): void {
    this.#holds.set(sessionId, (this.#holds.get(sessionId) ?? 0) + 1);
  }

  #release(sessionId: string): void {
    const left = (this.#holds.get(sessionId) ?? 1) - 1;
    if (left === 0) this.#holds.delete(sessionId);
    else this.#holds.set(sessionId, left);
  }

  /** The daemon is stopping: write everything still waiting, and schedule nothing after it. */
  async close(): Promise<void> {
    this.#stopping = true;
    await this.flush();
  }

  /** Writes every draft still waiting for its timer, now. */
  async flush(): Promise<void> {
    for (const live of [...this.#live.values(), ...this.#unwritten.values()]) {
      live.timer?.cancel();
      live.timer = undefined;
      if (live.dirty) this.#write(live);
    }
    await Promise.all(this.#writes);
  }

  /** The edit's text, transformed past everything sequenced after its base. */
  #sequence(live: LiveDraft, edit: SharedDraftEdit): TextOp {
    // No text change keeps the whole text, at whatever revision it lands.
    if (edit.text === undefined) return identity(live.snapshot.text);
    let op = edit.text;
    try {
      for (const entry of live.history.slice(edit.base - live.historyStart))
        op = transformTextOps(entry.applied.text, op)[1];
      if (textOpBaseLength(op) !== live.snapshot.text.length) throw new TextOpError('length');
    } catch (error) {
      if (!(error instanceof TextOpError)) throw error;
      throw new SharedDraftError(
        'invalid',
        `this edit does not fit the draft at revision ${edit.base}; read the draft again`,
      );
    }
    return normalizeTextOp(op);
  }

  async #draft(sessionId: string): Promise<LiveDraft> {
    const live = this.#live.get(sessionId);
    if (live !== undefined) {
      // Most recently used goes to the back, so eviction takes the front.
      this.#live.delete(sessionId);
      this.#live.set(sessionId, live);
      return live;
    }
    // Let go of but not yet on disk: the memory copy is the newest there is, so it is taken back as it
    // stands — same generation, same history — rather than read from a file that is behind it.
    const unwritten = this.#unwritten.get(sessionId);
    if (unwritten !== undefined) {
      this.#unwritten.delete(sessionId);
      this.#live.set(sessionId, unwritten);
      this.#evict();
      return unwritten;
    }
    const pending = this.#loading.get(sessionId);
    if (pending !== undefined) return await pending;
    const loading = this.#load(sessionId).finally(() => this.#loading.delete(sessionId));
    this.#loading.set(sessionId, loading);
    return await loading;
  }

  async #load(sessionId: string): Promise<LiveDraft> {
    if (!(await this.sessions.has(sessionId))) throw new SharedDraftError('not-found', `no session ${sessionId}`);
    // A write that already left may still be on its way to disk; read after it lands.
    await Promise.all(this.#writes);
    const stored = await this.repository.load(sessionId);
    const base = stored ?? {
      v: SHARED_DRAFT_SCHEMA_VERSION,
      sessionId,
      epoch: 0,
      rev: 0,
      text: '',
      items: [],
      updatedAt: this.clock.now(),
    };
    // A new life for this draft: no revision number a device held before is trusted in it.
    const snapshot: SharedDraftSnapshot = { ...base, generation: this.generations.next() };
    const live: LiveDraft = {
      snapshot,
      history: [],
      historyChars: 0,
      historyStart: snapshot.rev,
      dirty: false,
      failures: 0,
    };
    this.#live.set(sessionId, live);
    this.#evict();
    return live;
  }

  #evict(): void {
    // Least recently used first, passing over any draft a read or an edit is still holding.
    for (const [sessionId, live] of [...this.#live]) {
      if (this.#live.size <= this.memoryLimit) return;
      if (this.#holds.has(sessionId)) continue;
      this.#live.delete(sessionId);
      if (!live.dirty && live.timer === undefined) continue;
      live.timer?.cancel();
      live.timer = undefined;
      this.#unwritten.set(sessionId, live);
      this.#write(live);
    }
  }

  #schedule(live: LiveDraft, delay: number = SHARED_DRAFT_WRITE_DELAY_MS): void {
    live.dirty = true;
    if (live.timer !== undefined) return;
    live.timer = this.scheduler.after(delay, () => {
      live.timer = undefined;
      this.#write(live);
    });
  }

  #write(live: LiveDraft): void {
    live.dirty = false;
    const snapshot = live.snapshot;
    const write = this.repository.save(snapshot).then(
      () => {
        live.failures = 0;
        // Written, and nothing newer since: a draft that was let go of may now really go. A newer
        // state keeps it, and that state's own write decides.
        const sessionId = snapshot.sessionId;
        if (live.snapshot === snapshot && this.#unwritten.get(sessionId) === live) this.#unwritten.delete(sessionId);
      },
      () => {
        // Still in memory — in `#live` or `#unwritten` — so nothing is lost. Try again, waiting longer
        // each time a disk keeps refusing; a daemon that is stopping does not schedule anything new.
        live.failures += 1;
        live.dirty = true;
        if (this.#stopping) return;
        this.#schedule(
          live,
          Math.min(SHARED_DRAFT_WRITE_DELAY_MS * 2 ** live.failures, SHARED_DRAFT_WRITE_RETRY_MAX_MS),
        );
      },
    );
    this.#writes.add(write);
    void write.finally(() => this.#writes.delete(write));
  }
}
