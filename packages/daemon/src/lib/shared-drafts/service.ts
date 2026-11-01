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
  SHARED_DRAFT_MAX_CHARS,
  SHARED_DRAFT_MAX_ITEMS,
  SHARED_DRAFT_SCHEMA_VERSION,
  type SharedDraftEdit,
  type SharedDraftEditResult,
  type SharedDraftItem,
  type SharedDraftSnapshot,
  type TextOp,
  TextOpError,
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

/** How long after its last change a draft is written down, and how long before a failed write is tried again. */
export const SHARED_DRAFT_WRITE_DELAY_MS = 1_000;
/** Drafts held in memory at once; the least recently used is written down and let go. */
export const SHARED_DRAFT_MEMORY_LIMIT = 50;
/**
 * Characters the remembered history may insert in total. A count alone would let 200 whole-draft
 * pastes sit in memory per session; past this the oldest edits are forgotten, and a base that old is
 * simply stale.
 */
export const SHARED_DRAFT_HISTORY_MAX_CHARS = 256_000;

type Applied = SharedDraftEditResult['applied'];

interface LiveDraft {
  snapshot: SharedDraftSnapshot;
  /** The edits after `historyStart`, oldest first; entry `i` moved the draft to `historyStart + i + 1`. */
  history: Applied[];
  /** Characters `history` inserts in total. */
  historyChars: number;
  /** The oldest revision an edit may still be based on. */
  historyStart: number;
  /** Not yet written down. */
  dirty: boolean;
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
    return (await this.#draft(sessionId)).snapshot;
  }

  /** Sequences one edit and answers with it as applied, and the draft after it. */
  async edit(sessionId: string, edit: SharedDraftEdit): Promise<SharedDraftEditResult> {
    const live = await this.#draft(sessionId);
    const current = live.snapshot;
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
    if (finished) {
      live.history = [];
      live.historyChars = 0;
      live.historyStart = 0;
    } else {
      live.history.push(applied);
      live.historyChars += insertedChars(text);
      while (
        live.history.length > SHARED_DRAFT_HISTORY_LIMIT ||
        (live.historyChars > SHARED_DRAFT_HISTORY_MAX_CHARS && live.history.length > 0)
      ) {
        const oldest = live.history.shift();
        live.historyChars -= oldest === undefined ? 0 : insertedChars(oldest.text);
      }
      live.historyStart = applied.rev - live.history.length;
    }
    this.#schedule(live);
    return { applied, snapshot: live.snapshot };
  }

  /** Writes every draft still waiting for its timer. Called when the daemon stops. */
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
      for (const entry of live.history.slice(edit.base - live.historyStart)) op = transformTextOps(entry.text, op)[1];
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
    const live: LiveDraft = { snapshot, history: [], historyChars: 0, historyStart: snapshot.rev, dirty: false };
    this.#live.set(sessionId, live);
    this.#evict();
    return live;
  }

  #evict(): void {
    while (this.#live.size > this.memoryLimit) {
      const [sessionId, live] = this.#live.entries().next().value as [string, LiveDraft];
      this.#live.delete(sessionId);
      if (!live.dirty && live.timer === undefined) continue;
      live.timer?.cancel();
      live.timer = undefined;
      this.#unwritten.set(sessionId, live);
      this.#write(live);
    }
  }

  #schedule(live: LiveDraft): void {
    live.dirty = true;
    if (live.timer !== undefined) return;
    live.timer = this.scheduler.after(SHARED_DRAFT_WRITE_DELAY_MS, () => {
      live.timer = undefined;
      this.#write(live);
    });
  }

  #write(live: LiveDraft): void {
    live.dirty = false;
    const snapshot = live.snapshot;
    const write = this.repository.save(snapshot).then(
      () => {
        // Written, and nothing newer since: a draft that was let go of may now really go. A newer
        // state keeps it, and that state's own write decides.
        const sessionId = snapshot.sessionId;
        if (live.snapshot === snapshot && this.#unwritten.get(sessionId) === live) this.#unwritten.delete(sessionId);
      },
      () => {
        // Still in memory — in `#live` or `#unwritten` — so nothing is lost; try again shortly.
        this.#schedule(live);
      },
    );
    this.#writes.add(write);
    void write.finally(() => this.#writes.delete(write));
  }
}
