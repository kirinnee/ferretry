import { describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AskComposerState, type AskDelivery, AskNotTypedError } from '../../../../contract/index.ts';
import { askDelivery } from '../../../../daemon/adapters/ask-delivery.ts';
import { FileAgendaTellStore } from '../../../../daemon/adapters/agenda/file-agenda-tell-store.ts';
import {
  AGENDA_REPLY_RECHECK_MS,
  type AgendaReplyTimers,
  AgendaTeller,
  type AgendaTells,
  type AgendaTellStore,
} from '../../../../daemon/lib/agenda/index.ts';
import { KeyedSerialQueue } from '../../../../daemon/lib/agenda/serial-queue.ts';
import { agendaFilePath, agendaFilesAt } from '../../../support/daemon/agenda-state.ts';

const FERRET = 'mvv6b4qw-49d0158d';

class MemoryTells implements AgendaTellStore {
  readonly files = new Map<string, AgendaTells>();
  async read(sessionId: string): Promise<AgendaTells | null> {
    return this.files.get(sessionId) ?? null;
  }
  async write(tells: AgendaTells): Promise<void> {
    this.files.set(tells.sessionId, structuredClone(tells));
  }
}

class HeldTimers implements AgendaReplyTimers {
  readonly tasks = new Map<string, { delayMs: number; task: () => void }>();
  schedule(key: string, delayMs: number, task: () => void): void {
    this.tasks.set(key, { delayMs, task });
  }
  cancel(key: string): void {
    this.tasks.delete(key);
  }
}

/** A delivery the case drives: what it was handed, what the composer says, whether it is provided at all. */
function world(overrides: { composer?: AskComposerState; provided?: boolean; refuse?: string } = {}) {
  const w = {
    composer: overrides.composer ?? ('empty' as AskComposerState),
    provided: overrides.provided ?? true,
    notTyped: false,
    refuse: overrides.refuse,
    sends: [] as { ferret: string; text: string; sendId: string }[],
  };
  const delivery: AskDelivery = {
    send: async (ferret, text, sendId) => {
      w.sends.push({ ferret, text, sendId });
      if (w.notTyped) throw new AskNotTypedError('the composer took a draft meanwhile');
      if (w.refuse !== undefined) throw new Error(w.refuse);
    },
    composer: async () => w.composer,
  };
  const ported = askDelivery(() => (w.provided ? delivery : 'unavailable'));
  const store = new MemoryTells();
  const timers = new HeldTimers();
  const teller = () => new AgendaTeller(store, ported.messenger, ported.ports.composer, timers, new KeyedSerialQueue());
  return { w, store, timers, teller };
}

describe('AgendaTeller', () => {
  it('types the text under the caller’s send id through the ask delivery', async () => {
    const { w, store, teller } = world();
    expect(await teller().tell(FERRET, 'A3 was answered and typed into %terminal:dev.', 'input-ended-x-A3')).toBe(
      'sent',
    );
    expect(w.sends).toEqual([
      { ferret: FERRET, text: 'A3 was answered and typed into %terminal:dev.', sendId: 'input-ended-x-A3' },
    ]);
    expect(store.files.get(FERRET)?.held).toEqual([]);
  });

  it('holds a tell while the composer is occupied, then types it from the retry timer like an answer', async () => {
    const { w, timers, teller, store } = world({ composer: 'occupied' });
    const tells = teller();
    expect(await tells.tell(FERRET, 'ended', 'send-1')).toBe('held');
    expect(w.sends).toEqual([]);
    expect(store.files.get(FERRET)?.held.map(each => each.sendId)).toEqual(['send-1']);
    expect(timers.tasks.get(`${FERRET}#tell`)?.delayMs).toBe(AGENDA_REPLY_RECHECK_MS);
    w.composer = 'unreadable';
    timers.tasks.get(`${FERRET}#tell`)?.task();
    await Bun.sleep(5);
    expect(w.sends).toEqual([]);
    w.composer = 'empty';
    timers.tasks.get(`${FERRET}#tell`)?.task();
    await Bun.sleep(5);
    expect(w.sends.map(each => each.sendId)).toEqual(['send-1']);
    expect(store.files.get(FERRET)?.held).toEqual([]);
    expect(store.files.get(FERRET)?.sent).toEqual(['send-1']);
  });

  it('holds a tell the send path says nothing was typed for, and keeps it for the retry', async () => {
    const { w, timers, teller, store } = world();
    w.notTyped = true;
    expect(await teller().tell(FERRET, 'ended', 'send-1')).toBe('held');
    expect(store.files.get(FERRET)?.held.length).toBe(1);
    expect(timers.tasks.has(`${FERRET}#tell`)).toBe(true);
  });

  it('holds a tell while no delivery is provided, and types it once one is', async () => {
    const { w, timers, teller, store } = world({ provided: false });
    expect(await teller().tell(FERRET, 'ended', 'send-1')).toBe('held');
    expect(w.sends).toEqual([]);
    expect(store.files.get(FERRET)?.held.map(each => each.text)).toEqual(['ended']);
    w.provided = true;
    timers.tasks.get(`${FERRET}#tell`)?.task();
    await Bun.sleep(5);
    expect(w.sends.map(each => each.sendId)).toEqual(['send-1']);
  });

  it('types the same send id once, whether it was sent or is still held', async () => {
    const sent = world();
    const first = sent.teller();
    expect(await first.tell(FERRET, 'ended', 'send-1')).toBe('sent');
    expect(await first.tell(FERRET, 'ended', 'send-1')).toBe('sent');
    expect(sent.w.sends.length).toBe(1);

    const held = world({ composer: 'occupied' });
    const second = held.teller();
    await second.tell(FERRET, 'ended', 'send-1');
    await second.tell(FERRET, 'ended', 'send-1');
    expect(held.store.files.get(FERRET)?.held.length).toBe(1);
    held.w.composer = 'empty';
    await second.tell(FERRET, 'ended', 'send-1');
    expect(held.w.sends.length).toBe(1);
  });

  it('keeps tells in the order they were made', async () => {
    const { w, teller } = world({ composer: 'occupied' });
    const tells = teller();
    await tells.tell(FERRET, 'one', 'a');
    await tells.tell(FERRET, 'two', 'b');
    w.composer = 'empty';
    await tells.tell(FERRET, 'three', 'c');
    expect(w.sends.map(each => each.text)).toEqual(['one', 'two', 'three']);
  });

  it('lets go of a tell the send path refused outright, instead of retrying it', async () => {
    const { w, store, timers, teller } = world({ refuse: 'no such ferret' });
    expect(await teller().tell(FERRET, 'ended', 'send-1')).toBe('held');
    expect(store.files.get(FERRET)?.held).toEqual([]);
    expect(store.files.get(FERRET)?.sent).toEqual([]);
    expect(timers.tasks.has(`${FERRET}#tell`)).toBe(false);
    expect(w.sends.length).toBe(1);
  });

  it('types what a restart interrupted, from the file it was kept in', async () => {
    const { w, store, teller } = world({ composer: 'occupied' });
    await teller().tell(FERRET, 'ended', 'send-1');
    w.composer = 'empty';
    await teller().resume([FERRET, 'other-ferret']);
    expect(w.sends.map(each => each.sendId)).toEqual(['send-1']);
    expect(store.files.get(FERRET)?.held).toEqual([]);
  });

  it('refuses an empty or oversized text and an empty send id', async () => {
    const { teller } = world();
    await expect(teller().tell(FERRET, '  ', 'x')).rejects.toThrow();
    await expect(teller().tell(FERRET, 'a'.repeat(4_097), 'x')).rejects.toThrow();
    await expect(teller().tell(FERRET, 'ok', '')).rejects.toThrow();
  });
});

describe('FileAgendaTellStore', () => {
  it('keeps held and sent tells in the ferret’s own file, and reads a damaged one as none', async () => {
    const home = await mkdtemp(join(tmpdir(), 'asks-tells-'));
    try {
      const store = new FileAgendaTellStore(agendaFilesAt(home));
      expect(await store.read(FERRET)).toBeNull();
      const tells: AgendaTells = { v: 1, sessionId: FERRET, held: [{ sendId: 's1', text: 'ended' }], sent: ['s0'] };
      await store.write(tells);
      expect(await store.read(FERRET)).toEqual(tells);
      expect(JSON.parse(await readFile(agendaFilePath(home, FERRET, 'agenda-tells.json'), 'utf8'))).toEqual(tells);
      await agendaFilesAt(home).writeAtomic(FERRET, 'agenda-tells.json', '{ not json');
      expect(await store.read(FERRET)).toBeNull();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
