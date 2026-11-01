import { describe, it } from 'bun:test';
import {
  applyTextOp,
  SHARED_DRAFT_HISTORY_LIMIT,
  type SharedDraftItem,
  type SharedDraftSnapshot,
} from '@ferretry/protocol';
import should from 'should';
import {
  SHARED_DRAFT_WRITE_DELAY_MS,
  type SharedDraftRepository,
  SharedDraftService,
} from '../../../src/lib/shared-drafts/index.ts';

const AT = '2026-11-01T00:00:00.000Z';

class MemoryDrafts implements SharedDraftRepository {
  readonly saved: SharedDraftSnapshot[] = [];
  fail = false;

  constructor(private readonly stored: Readonly<Record<string, SharedDraftSnapshot>> = {}) {}

  async load(sessionId: string): Promise<SharedDraftSnapshot | undefined> {
    const newest = [...this.saved].reverse().find(snapshot => snapshot.sessionId === sessionId);
    return newest ?? this.stored[sessionId];
  }

  async save(snapshot: SharedDraftSnapshot): Promise<void> {
    if (this.fail) throw new Error('disk full');
    this.saved.push(snapshot);
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
    readonly memoryLimit?: number;
  } = {},
) => {
  const repository = options.repository ?? new MemoryDrafts();
  const timers = new ManualTimers();
  const known = new Set(options.sessions ?? ['s1', 's2', 's3']);
  const service = new SharedDraftService(
    { has: async sessionId => known.has(sessionId) },
    repository,
    { now: () => AT },
    timers,
    options.memoryLimit,
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
      sessionId: 's1',
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
    await service.edit('s1', { epoch: 0, base: 0, text: ['hello'] });

    // Act — the phone appends, the laptop prepends, both against revision 1.
    const phone = await service.edit('s1', { epoch: 0, base: 1, text: [5, ' world'] });
    const laptop = await service.edit('s1', { epoch: 0, base: 1, text: ['oh ', 5] });

    // Assert — nobody's words are lost, and the laptop's edit comes back rewritten for revision 2.
    should(laptop.snapshot.text).equal('oh hello world');
    should(laptop.applied).deepEqual({ epoch: 0, rev: 3, text: ['oh ', 11], add: [], remove: [] });
    // The phone, at revision 2, applies the sequenced edit and lands on the same text.
    should(applyTextOp(phone.snapshot.text, laptop.applied.text)).equal(laptop.snapshot.text);
  });

  it('keeps an item edit and a text edit apart: no text means the text is untouched', async () => {
    const { service } = subject();
    await service.edit('s1', { epoch: 0, base: 0, text: ['caption'] });

    const result = await service.edit('s1', { epoch: 0, base: 0, add: [photo('a1')] });

    should(result.snapshot).match({ text: 'caption', rev: 2, items: [photo('a1')] });
    should(result.applied.text).deepEqual([7]);
  });

  it('adds an item once however often it is added, and removes only what is there', async () => {
    const { service } = subject();
    await service.edit('s1', { epoch: 0, base: 0, add: [photo('a1'), photo('a1'), photo('a2')] });

    const again = await service.edit('s1', { epoch: 0, base: 1, add: [photo('a1')], remove: ['a2', 'ghost'] });

    should(again.snapshot.items).deepEqual([photo('a1')]);
    should(again.applied).match({ add: [], remove: ['a2'] });
  });

  it('starts a NEW EPOCH when a send takes everything with it, and refuses an edit to the sent message', async () => {
    const { service } = subject();
    await service.edit('s1', { epoch: 0, base: 0, text: ['ship it'], add: [photo('a1')] });

    const sent = await service.edit('s1', { epoch: 0, base: 1, text: [-7], remove: ['a1'], sent: true });
    const late = service.edit('s1', { epoch: 0, base: 1, text: [7, '!'] });

    should(sent.snapshot).match({ epoch: 1, rev: 0, text: '', items: [] });
    await should(late).be.rejectedWith({ name: 'SharedDraftError', code: 'stale' });
    should(await service.edit('s1', { epoch: 1, base: 0, text: ['next'] })).match({ snapshot: { epoch: 1, rev: 1 } });
  });

  it('KEEPS what somebody typed after the sender looked: a send only removes what it saw', async () => {
    // Arrange — the phone saw "ship it" at revision 1; the laptop then added a line.
    const { service } = subject();
    await service.edit('s1', { epoch: 0, base: 0, text: ['ship it'] });
    await service.edit('s1', { epoch: 0, base: 1, text: [7, '\nand the docs'] });

    // Act — the phone sends what it saw.
    const sent = await service.edit('s1', { epoch: 0, base: 1, text: [-7], sent: true });

    // Assert — the laptop's line survives, and the message is not over yet.
    should(sent.snapshot).match({ epoch: 0, rev: 3, text: '\nand the docs' });
  });

  it('refuses a base outside the remembered history, and one from the future', async () => {
    const { service } = subject();
    for (let rev = 0; rev <= SHARED_DRAFT_HISTORY_LIMIT; rev += 1)
      await service.edit('s1', { epoch: 0, base: rev, text: rev === 0 ? ['x'] : [rev, 'x'] });

    await should(service.edit('s1', { epoch: 0, base: 0, text: ['y'] })).be.rejectedWith({
      name: 'SharedDraftError',
      code: 'stale',
    });
    await should(service.edit('s1', { epoch: 0, base: 999, text: ['y'] })).be.rejectedWith({
      name: 'SharedDraftError',
      code: 'stale',
    });
    // The oldest remembered base still merges.
    const oldest = SHARED_DRAFT_HISTORY_LIMIT + 1 - SHARED_DRAFT_HISTORY_LIMIT;
    should(await service.edit('s1', { epoch: 0, base: oldest, text: ['y', oldest] })).match({
      snapshot: { rev: SHARED_DRAFT_HISTORY_LIMIT + 2 },
    });
  });

  it('refuses an edit that does not fit the text at its base', async () => {
    const { service } = subject();
    await service.edit('s1', { epoch: 0, base: 0, text: ['abc'] });

    await should(service.edit('s1', { epoch: 0, base: 1, text: [5, 'x'] })).be.rejectedWith({
      name: 'SharedDraftError',
      code: 'invalid',
    });
    await should(service.edit('s1', { epoch: 0, base: 0, text: [2, 'x'] })).be.rejectedWith({
      name: 'SharedDraftError',
      code: 'invalid',
    });
  });

  it('writes a draft a second after it last changed, once, however many edits came in between', async () => {
    const { service, repository, timers } = subject();
    await service.edit('s1', { epoch: 0, base: 0, text: ['a'] });
    await service.edit('s1', { epoch: 0, base: 1, text: [1, 'b'] });

    should(timers.pending.map(entry => entry.milliseconds)).deepEqual([SHARED_DRAFT_WRITE_DELAY_MS]);
    should(repository.saved).be.empty();
    timers.fire();
    await settle();

    should(repository.saved.map(snapshot => snapshot.text)).deepEqual(['ab']);
  });

  it('writes whatever is still waiting when the daemon stops', async () => {
    const { service, repository } = subject();
    await service.edit('s1', { epoch: 0, base: 0, text: ['unsaved'] });

    await service.flush();

    should(repository.saved.map(snapshot => snapshot.text)).deepEqual(['unsaved']);
  });

  it('keeps a draft whose write failed waiting, so the next write includes it', async () => {
    const { service, repository } = subject();
    repository.fail = true;
    await service.edit('s1', { epoch: 0, base: 0, text: ['a'] });
    await service.flush();
    repository.fail = false;

    await service.flush();

    should(repository.saved.map(snapshot => snapshot.text)).deepEqual(['a']);
  });

  it('reads a stored draft back, and merges only an edit based on exactly that revision', async () => {
    const stored: SharedDraftSnapshot = {
      v: 1,
      sessionId: 's1',
      epoch: 2,
      rev: 7,
      text: 'kept',
      items: [],
      updatedAt: AT,
    };
    const { service } = subject({ repository: new MemoryDrafts({ s1: stored }) });

    should(await service.read('s1')).deepEqual(stored);
    await should(service.edit('s1', { epoch: 2, base: 6, text: [4, '!'] })).be.rejectedWith({
      name: 'SharedDraftError',
      code: 'stale',
    });
    should(await service.edit('s1', { epoch: 2, base: 7, text: [4, '!'] })).match({ snapshot: { text: 'kept!' } });
  });

  it('lets go of the least recently used draft, writing it first, and reads it back intact', async () => {
    const { service, repository } = subject({ memoryLimit: 1 });
    await service.edit('s1', { epoch: 0, base: 0, text: ['first'] });

    await service.read('s2');
    await settle();

    should(repository.saved.map(snapshot => snapshot.text)).deepEqual(['first']);
    should(await service.read('s1')).match({ text: 'first', rev: 1 });
  });

  it('loads one session once for callers that arrive together', async () => {
    let loads = 0;
    const repository = new MemoryDrafts();
    const counting: SharedDraftRepository = {
      load: async sessionId => {
        loads += 1;
        return await repository.load(sessionId);
      },
      save: async snapshot => await repository.save(snapshot),
    };
    const service = new SharedDraftService({ has: async () => true }, counting, { now: () => AT }, new ManualTimers());

    await Promise.all([service.read('s1'), service.read('s1'), service.read('s1')]);

    should(loads).equal(1);
  });
});
