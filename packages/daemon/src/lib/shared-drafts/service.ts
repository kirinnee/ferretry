/**
 * THE DAEMON'S SIDE OF THE SHARED DRAFT: the one sequencer every device's edits pass through.
 *
 * An edit names the revision it was made against. Everything that landed after that revision is still
 * in {@link SHARED_DRAFT_HISTORY_LIMIT} remembered edits, so the new one is transformed past each of
 * them in turn, applied, and handed back AS SEQUENCED — the form any device already at the previous
 * revision can apply without thinking. That is the whole concurrency story (`@ferretry/protocol`
 * `shared-draft.ts` holds the transform itself, shared with the app).
 *
 * MEMORY FIRST, DISK SOON AFTER. A draft is typed at keystroke rate, so it lives in memory and is
 * written {@link SHARED_DRAFT_WRITE_DELAY_MS} after it last changed; {@link SharedDraftService.flush}
 * writes whatever is still waiting when the daemon stops. A crash can lose at most that last second,
 * and every device still holds its own copy of what it typed.
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
  type SharedDraftRepository,
  type SharedDraftScheduler,
  type SharedDraftSessionDirectory,
} from './types.ts';

/** How long after its last change a draft is written down. */
export const SHARED_DRAFT_WRITE_DELAY_MS = 1_000;
/** Drafts held in memory at once; the least recently used is written down and let go. */
export const SHARED_DRAFT_MEMORY_LIMIT = 50;

type Applied = SharedDraftEditResult['applied'];

interface LiveDraft {
  snapshot: SharedDraftSnapshot;
  /** The edits after `historyStart`, oldest first; entry `i` moved the draft to `historyStart + i + 1`. */
  history: Applied[];
  /** The oldest revision an edit may still be based on. */
  historyStart: number;
  /** Not yet written down. */
  dirty: boolean;
  timer?: { cancel(): void };
}

const identity = (text: string): TextOp => (text.length === 0 ? [] : [text.length]);

export class SharedDraftService {
  readonly #live = new Map<string, LiveDraft>();
  readonly #loading = new Map<string, Promise<LiveDraft>>();
  /** Writes in flight, so `flush` can wait for one a timer already started. */
  readonly #writes = new Set<Promise<void>>();

  constructor(
    private readonly sessions: SharedDraftSessionDirectory,
    private readonly repository: SharedDraftRepository,
    private readonly clock: SharedDraftClock,
    private readonly scheduler: SharedDraftScheduler,
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
    const nextText = applyTextOp(current.text, text);
    if (nextText.length > SHARED_DRAFT_MAX_CHARS)
      throw new SharedDraftError('too-long', `a draft holds at most ${SHARED_DRAFT_MAX_CHARS} characters`);

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

    const applied: Applied = { epoch: current.epoch, rev: current.rev + 1, text, add: added, remove: removed };
    // A send that took everything with it ends this message: the next one starts a new epoch, so an
    // edit somebody typed into the old one can never land in it.
    const finished = edit.sent === true && nextText === '' && items.length === 0;
    live.snapshot = {
      v: SHARED_DRAFT_SCHEMA_VERSION,
      sessionId,
      epoch: finished ? current.epoch + 1 : current.epoch,
      rev: finished ? 0 : applied.rev,
      text: nextText,
      items,
      updatedAt: this.clock.now(),
    };
    if (finished) {
      live.history = [];
      live.historyStart = 0;
    } else {
      live.history.push(applied);
      if (live.history.length > SHARED_DRAFT_HISTORY_LIMIT) live.history.shift();
      live.historyStart = applied.rev - live.history.length;
    }
    this.#schedule(live);
    return { applied, snapshot: live.snapshot };
  }

  /** Writes every draft still waiting for its timer. Called when the daemon stops. */
  async flush(): Promise<void> {
    for (const live of this.#live.values()) {
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
    const pending = this.#loading.get(sessionId);
    if (pending !== undefined) return await pending;
    const loading = this.#load(sessionId).finally(() => this.#loading.delete(sessionId));
    this.#loading.set(sessionId, loading);
    return await loading;
  }

  async #load(sessionId: string): Promise<LiveDraft> {
    if (!(await this.sessions.has(sessionId))) throw new SharedDraftError('not-found', `no session ${sessionId}`);
    // A draft let go of a moment ago may still be on its way to disk; read it after it lands.
    await Promise.all(this.#writes);
    const stored = await this.repository.load(sessionId);
    const snapshot: SharedDraftSnapshot = stored ?? {
      v: SHARED_DRAFT_SCHEMA_VERSION,
      sessionId,
      epoch: 0,
      rev: 0,
      text: '',
      items: [],
      updatedAt: this.clock.now(),
    };
    // A draft read back from disk has no history: only an edit based on exactly this revision merges.
    const live: LiveDraft = { snapshot, history: [], historyStart: snapshot.rev, dirty: false };
    this.#live.set(sessionId, live);
    this.#evict();
    return live;
  }

  #evict(): void {
    while (this.#live.size > this.memoryLimit) {
      const [sessionId, live] = this.#live.entries().next().value as [string, LiveDraft];
      live.timer?.cancel();
      if (live.dirty) this.#write(live);
      this.#live.delete(sessionId);
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
    const write = this.repository.save(live.snapshot).catch(() => {
      // Still in memory and every device still holds its copy: the next change tries again.
      live.dirty = true;
    });
    this.#writes.add(write);
    void write.finally(() => this.#writes.delete(write));
  }
}
