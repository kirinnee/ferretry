import type { FerretId } from '@ferretry/core-ferrets/contract';
import type { Instant } from '@ferretry/std';
import { describe, it } from 'bun:test';
import {
  applyTextOp,
  SHARED_DRAFT_HISTORY_LIMIT,
  SHARED_DRAFT_ITEMS_BUDGET,
  SHARED_DRAFT_MAX_ITEM_DRAFTS,
  type SharedDraftItem,
  type SharedDraftSnapshot,
  sharedDraftFrameBytes,
} from '../../../../daemon/seams/protocol.ts';
import should from 'should';
import {
  SHARED_DRAFT_HISTORY_MAX_CHARS,
  SHARED_DRAFT_WRITE_DELAY_MS,
  SHARED_DRAFT_WRITE_RETRY_MAX_MS,
  type SharedDraftChange,
  type SharedDraftRepository,
  SharedDraftService,
  sharedDraftOrigin,
  splitSharedDraftOrigin,
} from '../../../../daemon/drafts/lib/index.ts';
import { at } from '../../../support/instant.ts';

const AT = at('2026-11-01T00:00:00.000Z');
/** The generation every draft a default subject loads is in. */
const G = 'gen-1';

class MemoryDrafts implements SharedDraftRepository {
  readonly saved: SharedDraftSnapshot[] = [];
  readonly removed: string[] = [];
  fail = false;

  /** `stored` is keyed by session id for a chat draft, and `session/item` for an item's. */
  constructor(private readonly stored: Readonly<Record<string, SharedDraftSnapshot>> = {}) {}

  async load(sessionId: string, slot?: string): Promise<SharedDraftSnapshot | undefined> {
    if (this.removed.includes(`${sessionId}/${slot}`) && slot !== undefined) return undefined;
    const newest = [...this.saved].reverse().find(snapshot => snapshot.ferret === sessionId && snapshot.slot === slot);
    return newest ?? this.stored[slot === undefined ? sessionId : `${sessionId}/${slot}`];
  }

  async save(snapshot: SharedDraftSnapshot): Promise<void> {
    if (this.fail) throw new Error('disk full');
    this.saved.push(snapshot);
  }

  async remove(sessionId: string, slot: string): Promise<void> {
    this.removed.push(`${sessionId}/${slot}`);
    for (let index = this.saved.length - 1; index >= 0; index -= 1) {
      const snapshot = this.saved[index];
      if (snapshot?.ferret === sessionId && snapshot.slot === slot) this.saved.splice(index, 1);
    }
  }

  async items(sessionId: string): Promise<readonly string[]> {
    const slots = new Set<string>();
    for (const snapshot of this.saved)
      if (snapshot.ferret === sessionId && snapshot.slot !== undefined) slots.add(snapshot.slot);
    for (const [key, snapshot] of Object.entries(this.stored))
      if (key.startsWith(`${sessionId}/`) && snapshot.slot !== undefined) slots.add(snapshot.slot);
    return [...slots].filter(slot => !this.removed.includes(`${sessionId}/${slot}`));
  }
}

/** A timer a test fires by hand. */
class ManualTimers {
  readonly pending: { milliseconds: number; action: () => void; cancelled: boolean }[] = [];

  after(milliseconds: number, action: () => void) {
    const entry = { milliseconds, action, cancelled: false };
    this.pending.push(entry);
    return { cancel: () => (entry.cancelled = true) };
  }

  fire(): void {
    for (const entry of this.pending.splice(0)) if (!entry.cancelled) entry.action();
  }
}

const subject = (
  options: {
    readonly repository?: MemoryDrafts;
    readonly sessions?: readonly string[];
    /** The agenda items open on every known session; A1 to A3 by default. */
    readonly openItems?: readonly string[];
    readonly memoryLimit?: number;
    readonly generation?: string;
    readonly editsPerSecond?: number;
    readonly clock?: { now(): Instant };
  } = {},
) => {
  const repository = options.repository ?? new MemoryDrafts();
  const timers = new ManualTimers();
  const known = new Set(options.sessions ?? ['s1', 's2', 's3']);
  const open = new Set(options.openItems ?? ['A1', 'A2', 'A3']);
  const service = new SharedDraftService(
    { has: async sessionId => known.has(sessionId), hasOpenItem: async (_sessionId, item) => open.has(item) },
    repository,
    options.clock ?? { now: () => AT },
    timers,
    { next: () => options.generation ?? G },
    options.memoryLimit,
    // These tests make hundreds of edits on a clock that never moves; the limit has a test of its own.
    options.editsPerSecond ?? Number.POSITIVE_INFINITY,
  );
  return { service, repository, timers };
};

const photo = (id: string): SharedDraftItem => ({
  kind: 'attachment',
  id,
  name: `${id}.png`,
  mime: 'image/png',
  bytes: 9,
});
const settle = async () => await new Promise(resolve => setTimeout(resolve, 0));

describe('SharedDraftService', () => {
  it('starts every session with an empty draft at epoch 0, revision 0', async () => {
    const { service } = subject();
    should(await service.read('s1')).deepEqual({
      v: 1,
      ferret: 's1' as FerretId,
      generation: G,
      epoch: 0,
      rev: 0,
      text: '',
      items: [],
      updatedAt: AT,
    });
  });

  it('refuses a session this daemon does not hold', async () => {
    const { service } = subject();
    await should(service.read('nope')).be.rejectedWith({ name: 'SharedDraftError', code: 'not-found' });
  });

  it('MERGES two devices typing at once: the later edit is transformed past the earlier', async () => {
    // Arrange — both devices saw "hello" at revision 1.
    const { service } = subject();
    await service.edit('s1', { generation: G, epoch: 0, base: 0, text: ['hello'] });

    // Act — the phone appends, the laptop prepends, both against revision 1.
    const phone = await service.edit('s1', { generation: G, epoch: 0, base: 1, text: [5, ' world'] });
    const laptop = await service.edit('s1', { generation: G, epoch: 0, base: 1, text: ['oh ', 5] });

    // Assert — nobody's words are lost, and the laptop's edit comes back rewritten for revision 2.
    should(laptop.snapshot.text).equal('oh hello world');
    should(laptop.applied).deepEqual({ generation: G, epoch: 0, rev: 3, text: ['oh ', 11], add: [], remove: [] });
    // The phone, at revision 2, applies the sequenced edit and lands on the same text.
    should(applyTextOp(phone.snapshot.text, laptop.applied.text)).equal(laptop.snapshot.text);
  });

  it('keeps an item edit and a text edit apart: no text means the text is untouched', async () => {
    const { service } = subject();
    await service.edit('s1', { generation: G, epoch: 0, base: 0, text: ['caption'] });

    const result = await service.edit('s1', { generation: G, epoch: 0, base: 0, add: [photo('a1')] });

    should(result.snapshot).match({ text: 'caption', rev: 2, items: [photo('a1')] });
    should(result.applied.text).deepEqual([7]);
  });

  it('adds an item once however often it is added, and removes only what is there', async () => {
    const { service } = subject();
    await service.edit('s1', { generation: G, epoch: 0, base: 0, add: [photo('a1'), photo('a1'), photo('a2')] });

    const again = await service.edit('s1', {
      generation: G,
      epoch: 0,
      base: 1,
      add: [photo('a1')],
      remove: ['a2', 'ghost'],
    });

    should(again.snapshot.items).deepEqual([photo('a1')]);
    should(again.applied).match({ add: [], remove: ['a2'] });
  });

  it('starts a NEW EPOCH when a send takes everything with it, and refuses an edit to the sent message', async () => {
    const { service } = subject();
    await service.edit('s1', { generation: G, epoch: 0, base: 0, text: ['ship it'], add: [photo('a1')] });

    const sent = await service.edit('s1', { generation: G, epoch: 0, base: 1, text: [-7], remove: ['a1'], sent: true });
    const late = service.edit('s1', { generation: G, epoch: 0, base: 1, text: [7, '!'] });

    should(sent.snapshot).match({ epoch: 1, rev: 0, text: '', items: [] });
    await should(late).be.rejectedWith({ name: 'SharedDraftError', code: 'stale' });
    should(await service.edit('s1', { generation: G, epoch: 1, base: 0, text: ['next'] })).match({
      snapshot: { epoch: 1, rev: 1 },
    });
  });

  it('KEEPS what somebody typed after the sender looked: a send only removes what it saw', async () => {
    // Arrange — the phone saw "ship it" at revision 1; the laptop then added a line.
    const { service } = subject();
    await service.edit('s1', { generation: G, epoch: 0, base: 0, text: ['ship it'] });
    await service.edit('s1', { generation: G, epoch: 0, base: 1, text: [7, '\nand the docs'] });

    // Act — the phone sends what it saw.
    const sent = await service.edit('s1', { generation: G, epoch: 0, base: 1, text: [-7], sent: true });

    // Assert — the laptop's line survives, and the message is not over yet.
    should(sent.snapshot).match({ epoch: 0, rev: 3, text: '\nand the docs' });
  });

  it('refuses a base outside the remembered history, and one from the future', async () => {
    const { service } = subject();
    for (let rev = 0; rev <= SHARED_DRAFT_HISTORY_LIMIT; rev += 1)
      await service.edit('s1', { generation: G, epoch: 0, base: rev, text: rev === 0 ? ['x'] : [rev, 'x'] });

    await should(service.edit('s1', { generation: G, epoch: 0, base: 0, text: ['y'] })).be.rejectedWith({
      name: 'SharedDraftError',
      code: 'stale',
    });
    await should(service.edit('s1', { generation: G, epoch: 0, base: 999, text: ['y'] })).be.rejectedWith({
      name: 'SharedDraftError',
      code: 'stale',
    });
    // The oldest remembered base still merges.
    const oldest = SHARED_DRAFT_HISTORY_LIMIT + 1 - SHARED_DRAFT_HISTORY_LIMIT;
    should(await service.edit('s1', { generation: G, epoch: 0, base: oldest, text: ['y', oldest] })).match({
      snapshot: { rev: SHARED_DRAFT_HISTORY_LIMIT + 2 },
    });
  });

  it('refuses an edit that does not fit the text at its base', async () => {
    const { service } = subject();
    await service.edit('s1', { generation: G, epoch: 0, base: 0, text: ['abc'] });

    await should(service.edit('s1', { generation: G, epoch: 0, base: 1, text: [5, 'x'] })).be.rejectedWith({
      name: 'SharedDraftError',
      code: 'invalid',
    });
    await should(service.edit('s1', { generation: G, epoch: 0, base: 0, text: [2, 'x'] })).be.rejectedWith({
      name: 'SharedDraftError',
      code: 'invalid',
    });
  });

  it('writes a draft a second after it last changed, once, however many edits came in between', async () => {
    const { service, repository, timers } = subject();
    await service.edit('s1', { generation: G, epoch: 0, base: 0, text: ['a'] });
    await service.edit('s1', { generation: G, epoch: 0, base: 1, text: [1, 'b'] });

    should(timers.pending.map(entry => entry.milliseconds)).deepEqual([SHARED_DRAFT_WRITE_DELAY_MS]);
    should(repository.saved).be.empty();
    timers.fire();
    await settle();

    should(repository.saved.map(snapshot => snapshot.text)).deepEqual(['ab']);
  });

  it('writes whatever is still waiting when the daemon stops', async () => {
    const { service, repository } = subject();
    await service.edit('s1', { generation: G, epoch: 0, base: 0, text: ['unsaved'] });

    await service.flush();

    should(repository.saved.map(snapshot => snapshot.text)).deepEqual(['unsaved']);
  });

  it('keeps a draft whose write failed waiting, so the next write includes it', async () => {
    const { service, repository } = subject();
    repository.fail = true;
    await service.edit('s1', { generation: G, epoch: 0, base: 0, text: ['a'] });
    await service.flush();
    repository.fail = false;

    await service.flush();

    should(repository.saved.map(snapshot => snapshot.text)).deepEqual(['a']);
  });

  it('reads a stored draft back, and merges only an edit based on exactly that revision', async () => {
    const stored: SharedDraftSnapshot = {
      v: 1,
      ferret: 's1' as FerretId,
      generation: 'from-before',
      epoch: 2,
      rev: 7,
      text: 'kept',
      items: [],
      updatedAt: AT,
    };
    const { service } = subject({ repository: new MemoryDrafts({ s1: stored }) });

    // The stored generation is replaced: this is a new life of the draft.
    should(await service.read('s1')).deepEqual({ ...stored, generation: G });
    await should(service.edit('s1', { generation: G, epoch: 2, base: 6, text: [4, '!'] })).be.rejectedWith({
      name: 'SharedDraftError',
      code: 'stale',
    });
    should(await service.edit('s1', { generation: G, epoch: 2, base: 7, text: [4, '!'] })).match({
      snapshot: { text: 'kept!' },
    });
  });

  it('lets go of the least recently used draft, writing it first, and reads it back intact', async () => {
    const { service, repository } = subject({ memoryLimit: 1 });
    await service.edit('s1', { generation: G, epoch: 0, base: 0, text: ['first'] });

    await service.read('s2');
    await settle();

    should(repository.saved.map(snapshot => snapshot.text)).deepEqual(['first']);
    should(await service.read('s1')).match({ text: 'first', rev: 1 });
  });

  it('M1: refuses an edit from before a restart, even when its revision number exists again', async () => {
    // Arrange — the disk holds revision 1; revisions 2 and 3 were only ever in memory when the daemon died.
    const repository = new MemoryDrafts();
    const before = subject({ repository });
    await before.service.edit('s1', { generation: G, epoch: 0, base: 0, text: ['ab'] });
    await before.service.flush();
    await before.service.edit('s1', { generation: G, epoch: 0, base: 1, text: [2, 'c'] });
    await before.service.edit('s1', { generation: G, epoch: 0, base: 2, text: [3, 'd'] });

    // Act — a new daemon reloads revision 1, one device moves it to a NEW revision 2, and a device still
    // at the old revision 2 sends an edit based on it.
    const after = subject({ repository, generation: 'gen-2' });
    const fresh = await after.service.read('s1');
    await after.service.edit('s1', { generation: 'gen-2', epoch: 0, base: 1, text: ['zz', 2] });
    const old = after.service.edit('s1', { generation: G, epoch: 0, base: 2, text: [3, '!'] });

    // Assert — refused, so the old device re-reads instead of splicing into text it never saw.
    should(fresh).match({ generation: 'gen-2', rev: 1, text: 'ab' });
    await should(old).be.rejectedWith({ name: 'SharedDraftError', code: 'stale' });
    should(await after.service.read('s1')).match({ rev: 2, text: 'zzab' });
  });

  it('M2: never brings back a sent message when the write of the emptied draft fails after it is let go of', async () => {
    // Arrange — one draft in memory at a time, and a disk that refuses the next write.
    const repository = new MemoryDrafts();
    const { service, timers } = subject({ repository, memoryLimit: 1 });
    await service.edit('s1', { generation: G, epoch: 0, base: 0, text: ['ship it'] });
    await service.flush();
    await service.edit('s1', { generation: G, epoch: 0, base: 1, text: [-7], sent: true });
    repository.fail = true;

    // Act — another session pushes s1 out of memory while its write fails; then s1 is read again.
    await service.read('s2');
    await settle();
    const back = await service.read('s1');

    // Assert — the emptied draft, not the stored "ship it".
    should(back).match({ epoch: 1, rev: 0, text: '' });
    should(repository.saved.map(snapshot => snapshot.text)).deepEqual(['ship it']);

    // And once the disk recovers, the retry lands it.
    repository.fail = false;
    timers.fire();
    await settle();
    should(repository.saved.at(-1)).match({ epoch: 1, text: '' });
  });

  it('M2: keeps a draft let go of reachable until its write lands, then lets it go', async () => {
    // Arrange — a disk that holds the write until the test says so.
    let release: (() => void) | undefined;
    const saved: SharedDraftSnapshot[] = [];
    const slow: SharedDraftRepository = {
      load: async () => undefined,
      save: async snapshot => {
        await new Promise<void>(resolve => {
          release = resolve;
        });
        saved.push(snapshot);
      },
      remove: async () => undefined,
      items: async () => [],
    };
    const service = new SharedDraftService(
      { has: async () => true, hasOpenItem: async () => true },
      slow,
      { now: () => AT },
      new ManualTimers(),
      { next: () => G },
      1,
    );
    await service.edit('s1', { generation: G, epoch: 0, base: 0, text: ['kept'] });

    // Act — evicted with its write still in flight, then read back before the write lands.
    await service.read('s2');
    const meanwhile = await service.read('s1');
    // An edit based on the history from before eviction still merges: it is the same life of the draft.
    const merged = await service.edit('s1', { generation: G, epoch: 0, base: 0, text: ['oh '] });
    release?.();
    await settle();

    // Assert
    should(meanwhile).match({ text: 'kept', rev: 1 });
    // Transformed past revision 1, which wins the tie at position 0 because it was sequenced first.
    should(merged.snapshot.text).equal('keptoh ');
    should(saved.map(snapshot => snapshot.text)).deepEqual(['kept']);
  });

  it('L2: forgets the oldest edits once the history inserts too much, and calls a base that old stale', async () => {
    const { service } = subject();
    const half = 'x'.repeat(8_000);
    let rev = 0;
    let length = 0;
    // Each edit replaces the whole draft with 8,000 characters.
    for (; rev * 8_000 <= SHARED_DRAFT_HISTORY_MAX_CHARS + 8_000; rev += 1) {
      await service.edit('s1', { generation: G, epoch: 0, base: rev, text: length === 0 ? [half] : [-length, half] });
      length = half.length;
    }

    await should(service.edit('s1', { generation: G, epoch: 0, base: 1, text: [8_000, '!'] })).be.rejectedWith({
      name: 'SharedDraftError',
      code: 'stale',
    });
    should(await service.edit('s1', { generation: G, epoch: 0, base: rev - 1, text: [8_000, '!'] })).match({
      snapshot: { rev: rev + 1 },
    });
  });

  it('refuses an edit that names another generation', async () => {
    const { service } = subject();
    await should(service.edit('s1', { generation: 'other', epoch: 0, base: 0, text: ['x'] })).be.rejectedWith({
      name: 'SharedDraftError',
      code: 'stale',
    });
  });

  it('tells every subscriber of the session about each edit, with its origin, until it unsubscribes', async () => {
    const { service } = subject();
    const heard: SharedDraftChange[] = [];
    const other: SharedDraftChange[] = [];
    const stop = service.subscribe('s1', change => heard.push(change));
    service.subscribe('s1', () => {
      throw new Error('a broken stream');
    });
    service.subscribe('s2', change => other.push(change));

    await service.edit('s1', { generation: G, epoch: 0, base: 0, text: ['a'] }, 'phone');
    stop();
    stop();
    await service.edit('s1', { generation: G, epoch: 0, base: 1, text: [1, 'b'] });

    should(heard).match([{ applied: { rev: 1 }, epoch: 0, rev: 1, origin: 'phone' }]);
    should(other).be.empty();
  });

  it('says where a send left the draft: the next epoch, at revision 0', async () => {
    const { service } = subject();
    const heard: SharedDraftChange[] = [];
    service.subscribe('s1', change => heard.push(change));
    await service.edit('s1', { generation: G, epoch: 0, base: 0, text: ['x'] });
    await service.edit('s1', { generation: G, epoch: 0, base: 1, text: [-1], sent: true });
    should(heard.map(change => [change.applied.epoch, change.epoch, change.rev])).deepEqual([
      [0, 0, 1],
      [0, 1, 0],
    ]);
  });

  it('replays what a composer missed, or says it cannot', async () => {
    const { service } = subject();
    await service.edit('s1', { generation: G, epoch: 0, base: 0, text: ['a'] });
    await service.edit('s1', { generation: G, epoch: 0, base: 1, text: [1, 'b'] });

    should((await service.since('s1', { generation: G, epoch: 0, rev: 1 }))?.map(change => change.rev)).deepEqual([2]);
    should(await service.since('s1', { generation: G, epoch: 0, rev: 2 })).deepEqual([]);
    should(await service.since('s1', { generation: 'old', epoch: 0, rev: 1 })).be.undefined();
    should(await service.since('s1', { generation: G, epoch: 1, rev: 0 })).be.undefined();
    should(await service.since('s1', { generation: G, epoch: 0, rev: 9 })).be.undefined();
  });

  it('never lets go of a draft an edit is holding, however many others load meanwhile', async () => {
    // Arrange — one draft in memory; s1 is clean, so letting it go would drop it without a write.
    const repository = new MemoryDrafts();
    const { service } = subject({ repository, memoryLimit: 1 });
    await service.read('s1');

    // Act — an edit to s1 and a load of s2 start in the same tick.
    const [edited] = await Promise.all([
      service.edit('s1', { generation: G, epoch: 0, base: 0, text: ['kept'] }),
      service.read('s2'),
    ]);
    await settle();

    // Assert — the edit landed on the draft that stays reachable: reading s1 sees it.
    should(edited.snapshot.text).equal('kept');
    should(await service.read('s1')).match({ text: 'kept', rev: 1 });
  });

  it('waits longer after each failed write, up to a ceiling, and schedules nothing once closed', async () => {
    // Arrange
    const repository = new MemoryDrafts();
    repository.fail = true;
    const { service, timers } = subject({ repository });
    await service.edit('s1', { generation: G, epoch: 0, base: 0, text: ['x'] });

    // Act — fire the timer each time, letting each write fail.
    const delays: number[] = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const next = timers.pending.at(-1);
      if (next === undefined) break;
      delays.push(next.milliseconds);
      timers.fire();
      await settle();
    }
    await service.close();
    await settle();

    // Assert
    should(delays).deepEqual([
      SHARED_DRAFT_WRITE_DELAY_MS,
      2_000,
      4_000,
      8_000,
      16_000,
      32_000,
      SHARED_DRAFT_WRITE_RETRY_MAX_MS,
      SHARED_DRAFT_WRITE_RETRY_MAX_MS,
    ]);
    should(timers.pending.filter(entry => !entry.cancelled)).be.empty();
  });

  it('L4: keeps a draft with an open composer in memory, however many other drafts are read', async () => {
    const { service } = subject({ memoryLimit: 1, generation: G });
    const stop = service.subscribe('s1', () => undefined);
    await service.edit('s1', { generation: G, epoch: 0, base: 0, text: ['open here'] });

    await service.read('s2');
    await service.read('s3');

    // Still the same life of the draft: the composer's next edit merges.
    should(await service.edit('s1', { generation: G, epoch: 0, base: 1, text: [9, '!'] })).match({
      snapshot: { text: 'open here!' },
    });
    stop();
    stop();
  });

  it('L5: applies an edit sent twice once, answering the second with the first', async () => {
    const { service } = subject();
    const heard: SharedDraftChange[] = [];
    service.subscribe('s1', change => heard.push(change));
    const first = await service.edit(
      's1',
      { generation: G, epoch: 0, base: 0, text: ['once'] },
      sharedDraftOrigin('device:d1', 'old-stream', 'e1'),
    );

    // The composer reconnected and sent it again from a new stream.
    const again = await service.edit(
      's1',
      { generation: G, epoch: 0, base: 0, text: ['once'] },
      sharedDraftOrigin('device:d1', 'new-stream', 'e1'),
    );

    should(again.applied).deepEqual(first.applied);
    should(again.snapshot.text).equal('once');
    should(heard).have.length(1);
    // An edit with no id (the plain route) is never taken for a repeat.
    await service.edit('s1', { generation: G, epoch: 0, base: 1, text: [4, '!'] });
    should(splitSharedDraftOrigin(undefined)).be.undefined();
    should(splitSharedDraftOrigin('no-separator')).be.undefined();
  });

  it("4: never takes another device's edit for a repeat, even when it chose the same id", async () => {
    const { service } = subject();
    await service.edit(
      's1',
      { generation: G, epoch: 0, base: 0, text: ['phone '] },
      sharedDraftOrigin('device:phone', 'p', 'e1'),
    );
    const laptop = await service.edit(
      's1',
      { generation: G, epoch: 0, base: 1, text: [6, 'laptop'] },
      sharedDraftOrigin('device:laptop', 'l', 'e1'),
    );
    should(laptop.snapshot).match({ text: 'phone laptop', rev: 2 });
  });

  it('5: takes at most so many edits a second from one device, and more the next second', async () => {
    let now = Date.parse(AT);
    const { service } = subject({ editsPerSecond: 3, clock: { now: () => new Date(now).toISOString() as Instant } });
    for (let rev = 0; rev < 3; rev += 1)
      await service.edit('s1', { generation: G, epoch: 0, base: rev, text: rev === 0 ? ['x'] : [rev, 'x'] });

    await should(service.edit('s1', { generation: G, epoch: 0, base: 3, text: [3, 'x'] })).be.rejectedWith({
      name: 'SharedDraftError',
      code: 'rate-limited',
    });
    now += 1_000;
    should(await service.edit('s1', { generation: G, epoch: 0, base: 3, text: [3, 'x'] })).match({
      snapshot: { rev: 4 },
    });
  });

  it("budgets each device on its own: one device's flood never refuses another's edit, nor the daemon's own", async () => {
    // Arrange — the phone uses its whole budget.
    const { service } = subject({ editsPerSecond: 2, clock: { now: () => AT } });
    const phone = (id: string) => sharedDraftOrigin('device:phone', 'st-1', id);
    await service.edit('s1', { generation: G, epoch: 0, base: 0, text: ['a'] }, phone('p1'));
    await service.edit('s1', { generation: G, epoch: 0, base: 1, text: [1, 'b'] }, phone('p2'));
    await should(service.edit('s1', { generation: G, epoch: 0, base: 2, text: [2, 'c'] }, phone('p3'))).be.rejectedWith(
      {
        code: 'rate-limited',
      },
    );

    // Act — the laptop types, and a send's clear arrives from the daemon itself, in the same second.
    const laptop = await service.edit(
      's1',
      { generation: G, epoch: 0, base: 2, text: [2, '!'] },
      sharedDraftOrigin('device:laptop', 'st-2', 'l1'),
    );
    const cleared = await service.edit(
      's1',
      { generation: G, epoch: 0, base: 3, text: [-2, 1] },
      sharedDraftOrigin('device:phone', 'send', 'req-1'),
      { metered: false },
    );

    // Assert
    should(laptop.snapshot).match({ text: 'ab!', rev: 3 });
    should(cleared.snapshot).match({ text: '!', rev: 4 });
    // An edit with no origin counts against the author it names: the phone's, over HTTP, is still refused.
    await should(
      service.edit('s1', { generation: G, epoch: 0, base: 4, text: [1, '?'] }, undefined, { author: 'device:phone' }),
    ).be.rejectedWith({ code: 'rate-limited' });
  });

  it('L2: refuses files and places whose names together would not fit one frame', async () => {
    const { service } = subject();
    const longNamed = Array.from({ length: 20 }, (_, index) => ({
      kind: 'attachment' as const,
      id: `a${index}`,
      name: '"'.repeat(255),
      mime: 'image/png',
      bytes: 1,
    }));
    await should(service.edit('s1', { generation: G, epoch: 0, base: 0, add: longNamed })).be.rejectedWith({
      name: 'SharedDraftError',
      code: 'too-many-items',
    });
  });

  it('trims a stored draft whose files and places no longer fit one frame, keeping the leading ones', async () => {
    const longNamed = Array.from({ length: 20 }, (_, index) => ({
      kind: 'attachment' as const,
      id: `a${index}`,
      name: '"'.repeat(255),
      mime: 'image/png',
      bytes: 1,
    }));
    const stored: SharedDraftSnapshot = {
      v: 1,
      ferret: 's1' as FerretId,
      generation: 'old',
      epoch: 0,
      rev: 3,
      text: 'kept',
      items: longNamed,
      updatedAt: AT,
    };
    const repository = new MemoryDrafts({ s1: stored });
    const { service, timers } = subject({ repository });

    const read = await service.read('s1');
    timers.fire();
    await settle();

    should(read.text).equal('kept');
    should(read.items.length).be.above(0).and.below(20);
    should(read.items).deepEqual(longNamed.slice(0, read.items.length));
    should(sharedDraftFrameBytes(read.items)).be.belowOrEqual(SHARED_DRAFT_ITEMS_BUDGET);
    // Written back trimmed, so the file on disk shrinks too.
    should(repository.saved.map(snapshot => snapshot.items.length)).deepEqual([read.items.length]);
  });

  it('writes nothing back for a stored draft that already fits', async () => {
    const { service, repository, timers } = subject({
      repository: new MemoryDrafts({
        s1: { v: 1, ferret: 's1' as FerretId, generation: 'old', epoch: 0, rev: 0, text: '', items: [], updatedAt: AT },
      }),
    });
    await service.read('s1');
    timers.fire();
    await settle();
    should(repository.saved).be.empty();
  });

  it('loads one session once for callers that arrive together', async () => {
    let loads = 0;
    const repository = new MemoryDrafts();
    const counting: SharedDraftRepository = {
      load: async (sessionId, slot) => {
        loads += 1;
        return await repository.load(sessionId, slot);
      },
      save: async snapshot => await repository.save(snapshot),
      remove: async (sessionId, slot) => await repository.remove(sessionId, slot),
      items: async sessionId => await repository.items(sessionId),
    };
    const service = new SharedDraftService(
      { has: async () => true, hasOpenItem: async () => true },
      counting,
      { now: () => AT },
      new ManualTimers(),
      {
        next: () => G,
      },
    );

    await Promise.all([service.read('s1'), service.read('s1'), service.read('s1')]);

    should(loads).equal(1);
  });
});

describe('SharedDraftService draft slots (&B142)', () => {
  const typed = async (service: SharedDraftService, text: string, slot?: string) =>
    await service.edit(
      's1',
      { generation: G, epoch: 0, base: 0, text: [text] },
      undefined,
      slot === undefined ? {} : { slot },
    );

  it('keeps the chat draft and each item draft of one session apart, down to their revisions', async () => {
    // Arrange
    const { service } = subject();

    // Act
    await typed(service, 'chat words');
    await typed(service, 'first card', 'A1');
    await typed(service, 'second card', 'A2');
    await service.edit('s1', { generation: G, epoch: 0, base: 1, text: [10, '!'] });

    // Assert
    should(await service.read('s1')).match({ text: 'chat words!', rev: 2 });
    should(await service.read('s1', 'A1')).match({ slot: 'A1', text: 'first card', rev: 1 });
    should(await service.read('s1', 'A2')).match({ slot: 'A2', text: 'second card', rev: 1 });
    should(await service.read('s1')).not.have.property('slot');
  });

  it('tells only the listeners of one draft about its edits', async () => {
    // Arrange
    const { service } = subject();
    const chat: SharedDraftChange[] = [];
    const card: SharedDraftChange[] = [];
    service.subscribe('s1', change => chat.push(change));
    service.subscribe('s1', change => card.push(change), 'A1');

    // Act
    await typed(service, 'to the card', 'A1');
    await typed(service, 'to the chat');

    // Assert
    should(card.map(change => change.applied.text)).deepEqual([['to the card']]);
    should(chat.map(change => change.applied.text)).deepEqual([['to the chat']]);
  });

  it('answers a catch-up for one draft from that draft alone', async () => {
    // Arrange
    const { service } = subject();
    await typed(service, 'chat');
    await typed(service, 'card', 'A1');

    // Act
    const missed = await service.since('s1', { generation: G, epoch: 0, rev: 0 }, 'A1');

    // Assert
    should(missed?.map(change => change.applied.text)).deepEqual([['card']]);
  });

  it('writes an item draft to its own record, naming its slot, and the chat draft to the record it always had', async () => {
    // Arrange
    const { service, repository, timers } = subject();
    await typed(service, 'chat');
    await typed(service, 'card', 'A1');

    // Act
    timers.fire();
    await settle();

    // Assert
    should(repository.saved.map(snapshot => [snapshot.slot, snapshot.text])).deepEqual([
      [undefined, 'chat'],
      ['A1', 'card'],
    ]);
  });

  it('refuses an item that is not open on the session, or a session it is on but another holds', async () => {
    // Arrange
    const { service } = subject();

    // Act / Assert
    await should(service.read('s1', 'A9')).be.rejectedWith({ name: 'SharedDraftError', code: 'not-found' });
    await should(typed(service, 'x', 'A9')).be.rejectedWith({ name: 'SharedDraftError', code: 'not-found' });
    await should(service.read('nope', 'A1')).be.rejectedWith({ name: 'SharedDraftError', code: 'not-found' });
  });

  it('bounds the item drafts of one session, while every existing one stays editable', async () => {
    // Arrange — a session already holding as many item drafts as it may.
    const stored: Record<string, SharedDraftSnapshot> = {};
    for (let index = 1; index <= SHARED_DRAFT_MAX_ITEM_DRAFTS; index += 1)
      stored[`s1/A${index}`] = {
        v: 1,
        ferret: 's1' as FerretId,
        slot: `A${index}`,
        generation: G,
        epoch: 0,
        rev: 1,
        text: 'kept',
        items: [],
        updatedAt: AT,
      };
    const open = Array.from({ length: SHARED_DRAFT_MAX_ITEM_DRAFTS + 1 }, (_, index) => `A${index + 1}`);
    const { service } = subject({ repository: new MemoryDrafts(stored), openItems: open });

    // Act / Assert
    await should(typed(service, 'one too many', `A${SHARED_DRAFT_MAX_ITEM_DRAFTS + 1}`)).be.rejectedWith({
      name: 'SharedDraftError',
      code: 'too-many-drafts',
    });
    should(await service.read('s1', 'A1')).match({ text: 'kept' });
    await should(typed(service, 'chat is never counted')).be.fulfilled();
  });

  it('discards an item draft with the item: memory, disk, and a write still waiting', async () => {
    // Arrange
    const { service, repository, timers } = subject();
    await typed(service, 'card', 'A1');
    await typed(service, 'chat');

    // Act
    await service.discard('s1', 'A1');
    timers.fire();
    await settle();

    // Assert — the item's words are gone from both, the chat draft is untouched, and nothing writes the item again.
    should(repository.removed).deepEqual(['s1/A1']);
    should(repository.saved.map(snapshot => snapshot.slot)).deepEqual([undefined]);
    should(await service.read('s1')).match({ text: 'chat' });
  });

  it('starts an item that was discarded and opens again from nothing', async () => {
    // Arrange
    const { service } = subject();
    await typed(service, 'before', 'A1');
    await service.discard('s1', 'A1');

    // Act
    const reread = await service.read('s1', 'A1');

    // Assert
    should(reread).match({ text: '', rev: 0 });
  });

  it('discards an item that never had a draft without trouble, and never touches the chat draft', async () => {
    const { service } = subject();
    await typed(service, 'chat');
    await service.discard('s1', 'A3');
    should(await service.read('s1')).match({ text: 'chat' });
  });
});
