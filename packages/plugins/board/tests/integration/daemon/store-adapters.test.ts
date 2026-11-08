import { describe, expect, test } from 'bun:test';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import type { StateFileDef, StatePort } from '@ferretry/kernel/contract';
import { MemoryStateFolder } from '@ferretry/kernel/testing';
import type { BoardProjectId, Card, CardId } from '../../../contract/index.ts';
import { BoardFiles, BoardSwitchFiles, LaneSetFiles } from '../../../daemon/adapters/lanes/index.ts';
import { KernelCardStore } from '../../../daemon/adapters/store/card-store.ts';
import { KernelFerretFocus } from '../../../daemon/adapters/store/focus-store.ts';
import { KernelSweepMemory } from '../../../daemon/adapters/store/sweep-memory.ts';
import { BoardUnavailableError, EMPTY_SWEEP_MEMORY } from '../../../daemon/lib/board/index.ts';
import { KeyedSerial } from '../../../daemon/lib/lanes/index.ts';
import manifest from '../../../manifest.ts';
import { card } from '../../unit/board/support.ts';

const file = (name: string): StateFileDef<string, never> =>
  manifest.data.state.find(candidate => candidate.name === name) as never;
const CARDS = file('cards');
const COUNTERS = file('counters');
const SWEEP = file('sweep');
const FOCUS = file('focus');
const BOARDS = file('boards');

const warnings = () => {
  const said: string[] = [];
  return { said, diagnostics: { warn: (message: string) => void said.push(message) } };
};

describe('the card store over the board’s state folder', () => {
  const store = (folder = new MemoryStateFolder()) => {
    const { said, diagnostics } = warnings();
    const state = folder.port([CARDS, COUNTERS]);
    return {
      folder,
      said,
      state,
      store: new KernelCardStore(
        state,
        { cards: CARDS as never, counters: COUNTERS as never },
        new KeyedSerial(),
        diagnostics,
      ),
    };
  };
  const keep =
    (id: string, over: Partial<Card> = {}): Parameters<KernelCardStore['write']>[1] =>
    async () => ({ task: card({ id, ...over }), result: id });

  test('ids are handed out per kind and a restarted store carries on above them, never reusing one', async () => {
    const { folder, store: first } = store();
    expect(await first.allocateId('feature')).toBe('F1');
    expect(await first.allocateId('feature')).toBe('F2');
    expect(await first.allocateId('bug')).toBe('B1');
    await first.write('F2' as CardId, keep('F2'));

    const again = store(folder).store;

    expect(await again.allocateId('feature')).toBe('F3');
    expect((await again.read()).cards.map(each => each.id)).toEqual(['F2']);
  });

  test('a card written is read back; a decision that stores nothing writes nothing and answers its result', async () => {
    const { folder, store: cards } = store();

    expect(await cards.write('F1' as CardId, keep('F1'))).toBe('F1');
    expect(await cards.write('F1' as CardId, async current => ({ task: null, result: current?.id }))).toBe('F1');
    expect(await cards.write('F9' as CardId, async current => ({ task: null, result: current?.id }))).toBeUndefined();

    expect([...folder.files.keys()]).toEqual(['cards/F1.json', 'counters.json'].filter(path => folder.files.has(path)));
    expect((await cards.read()).quarantined).toEqual([]);
  });

  test('a write that stores another card than it was asked for is refused', async () => {
    const { store: cards } = store();

    await expect(cards.write('F1' as CardId, keep('F2'))).rejects.toBeInstanceOf(BoardUnavailableError);
  });

  test('a damaged card file is quarantined, reported once, never fatal, refused a write, and its number is never reused', async () => {
    const { folder, said, store: cards } = store();
    folder.plant(CARDS, '{ not json', 'F4');
    folder.plant(CARDS, JSON.stringify(card({ id: 'F7' })), 'F5');
    folder.plant(CARDS, JSON.stringify(card({ id: 'F1' })), 'F1');
    folder.plant(CARDS, JSON.stringify(card({ id: 'F6' })), 'notes');

    const snapshot = await cards.read();

    expect(snapshot.cards.map(each => each.id)).toEqual(['F1']);
    expect(snapshot.quarantined.map(each => each.id).sort()).toEqual(['F4', 'F5']);
    expect(said.join('\n')).toContain('board card F4 is quarantined');
    expect(said.join('\n')).toContain('board card F5 is quarantined: the card file names another card');
    await expect(cards.write('F4' as CardId, keep('F4'))).rejects.toMatchObject({
      detail: expect.stringContaining('quarantined'),
    });
    expect(folder.raw(CARDS, 'F4')).toBe('{ not json');
    expect(await cards.allocateId('feature')).toBe('F6');
  });

  test('a file that lists but reads as nothing is skipped, not quarantined', async () => {
    const { state } = store();
    const phantom = {
      ...state,
      list: async () => ['F3'],
      read: async () => ({ ok: true, value: undefined }),
    } as unknown as StatePort;
    const cards = new KernelCardStore(
      phantom,
      { cards: CARDS as never, counters: COUNTERS as never },
      new KeyedSerial(),
      warnings().diagnostics,
    );

    expect(await cards.read()).toEqual({ cards: [], quarantined: [] });
  });

  test('a damaged id counter is started again above the highest card on disk, and said so', async () => {
    const { folder, said, store: cards } = store();
    await cards.write('F5' as CardId, keep('F5'));
    folder.plant(COUNTERS, 'garbage');

    expect(await cards.allocateId('feature')).toBe('F6');
    expect(await cards.allocateId('feature')).toBe('F7');
    expect(said.filter(line => line.includes('id counter was damaged'))).toHaveLength(1);
  });

  test('an id counter at its end refuses to hand out another number', async () => {
    const { folder, store: cards } = store();
    folder.plant(COUNTERS, JSON.stringify({ format: 1, next: { bug: 1, feature: 1_000_000_000, infra: 1, chore: 1 } }));

    await expect(cards.allocateId('feature')).rejects.toMatchObject({
      detail: expect.stringContaining('counter is exhausted'),
    });
  });

  test('a first read that fails is not remembered: the next read loads again', async () => {
    const { folder, state, store: cards } = store();
    await state.write(CARDS as never, card({ id: 'F1' }), 'F1');
    folder.armCrash();
    await state.write(CARDS as never, card({ id: 'F2' }), 'F2').catch(() => undefined);

    await expect(cards.read()).rejects.toThrow('simulated crash');
    folder.revive();

    expect((await cards.read()).cards.map(each => each.id)).toEqual(['F1', 'F2']);
  });
});

describe('where each ferret’s work is focused', () => {
  const setup = (folder = new MemoryStateFolder()) => {
    const ferrets = new FakeFerrets();
    ferrets.add({ id: ferretId('f1') });
    const { said, diagnostics } = warnings();
    const titles: string[] = [];
    let failTitle = false;
    const focus = new KernelFerretFocus(
      folder.port([FOCUS]),
      FOCUS as never,
      ferrets,
      new KeyedSerial(),
      diagnostics,
      async (ferret, title) => {
        titles.push(`${ferret}:${title}`);
        if (failTitle) throw new Error('rename refused');
      },
    );
    return { folder, focus, said, titles, failTitles: () => (failTitle = true) };
  };

  test('a focus, its anchor and a skip are kept per ferret and survive a restart', async () => {
    const { folder, focus } = setup();
    expect(await focus.focusOf('f1')).toBeNull();
    expect(await focus.anchorOf('f1')).toBeNull();
    expect(await focus.skipOf('f1')).toBeNull();

    expect(await focus.setFocus('f1', { id: 'F1' } as never, undefined, { anchor: true })).toBe(true);
    expect(await focus.setFocus('f1', { id: 'F2' } as never)).toBe(true);
    expect(await focus.skip('f1', { reason: 'docs only', at: '2026-11-07T09:00:00.000Z', extra: 1 } as never)).toBe(
      true,
    );

    const again = setup(folder).focus;
    expect(await again.focusOf('f1')).toEqual({ id: 'F2' });
    expect(await again.anchorOf('f1')).toEqual({ id: 'F1' });
    expect(await again.skipOf('f1')).toEqual({ reason: 'docs only', at: '2026-11-07T09:00:00.000Z' });
    await again.setFocus('f1', { id: 'F3' } as never);
    expect(await again.skipOf('f1')).toBeNull();
  });

  test('a ferret that does not exist, or is no ferret id, cannot be focused or skipped', async () => {
    const { focus } = setup();

    expect(await focus.setFocus('ghost', { id: 'F1' } as never)).toBe(false);
    expect(await focus.setFocus('not a ferret id!', { id: 'F1' } as never)).toBe(false);
    expect(await focus.skip('ghost', { reason: 'x', at: '2026-11-07T09:00:00.000Z' } as never)).toBe(false);
  });

  test('a title names the ferret’s work, and a title that cannot be set never undoes the focus', async () => {
    const { focus, titles, failTitles } = setup();

    await focus.setFocus('f1', { id: 'F1' } as never, 'Badge colour');
    failTitles();
    expect(await focus.setFocus('f1', { id: 'F2' } as never, 'Other')).toBe(true);

    expect(titles).toEqual(['f1:Badge colour', 'f1:Other']);
    expect(await focus.focusOf('f1')).toEqual({ id: 'F2' });
  });

  test('a damaged focus file is never read as no focus and a write is never reported done, and both are warned about', async () => {
    const { folder, focus, said } = setup();
    folder.plant(FOCUS, '{ not json');

    await expect(focus.focusOf('f1')).rejects.toBeInstanceOf(BoardUnavailableError);
    await expect(focus.setFocus('f1', { id: 'F1' } as never)).rejects.toBeInstanceOf(BoardUnavailableError);
    expect(said.some(line => line.includes('could not be read'))).toBe(true);
    expect(said.some(line => line.includes('could not be written'))).toBe(true);
  });
});

describe('the board sweep’s memory', () => {
  const setup = (folder = new MemoryStateFolder()) => {
    const { said, diagnostics } = warnings();
    return { folder, said, memory: new KernelSweepMemory(folder.port([SWEEP]), SWEEP as never, diagnostics) };
  };

  test('reads as a fresh start before the first sweep, then as what the last sweep wrote', async () => {
    const { folder, memory } = setup();
    expect(await memory.read()).toEqual(EMPTY_SWEEP_MEMORY);
    const swept = { ...EMPTY_SWEEP_MEMORY, sweptAt: '2026-11-07T09:00:00.000Z' as never };

    await memory.write(swept);

    expect(await setup(folder).memory.read()).toEqual(swept);
  });

  test('a damaged memory reads as a fresh start and says so, costing at most one early nudge', async () => {
    const { folder, memory, said } = setup();
    folder.plant(SWEEP, '{ not json');

    expect(await memory.read()).toEqual(EMPTY_SWEEP_MEMORY);
    expect(said).toEqual(['the board sweep memory is damaged; starting it again']);
  });
});

describe('the per-project board files when the state under them misbehaves', () => {
  const PROJECT = '0b1f6d1e-6c1b-4f0c-8f4e-2f6f2a3c9a10' as BoardProjectId;
  const over = (port: Partial<StatePort>) => {
    const files = new BoardFiles(port as StatePort, BOARDS as never);
    return { lanes: new LaneSetFiles(files), switches: new BoardSwitchFiles(files) };
  };

  test('a failure that is not damage is passed on as it is, by the lane sets and the switches alike', async () => {
    const broken = over({
      read: async () => {
        throw new Error('the disk is gone');
      },
    });

    await expect(broken.lanes.read(PROJECT)).rejects.toThrow('the disk is gone');
    await expect(broken.switches.read(PROJECT)).rejects.toThrow('the disk is gone');
  });

  test('a stored lane set that its own schema refuses is refused, even when the state port let it through', async () => {
    const lying = over({
      read: async () =>
        ({
          ok: true,
          value: {
            format: 1,
            project: PROJECT,
            switch: { projectId: PROJECT, on: false, setBy: 'default', setAt: null },
            laneSet: { projectId: PROJECT, version: 1, confirmedBy: null, proposedBy: 'x', lanes: [{ id: 'Bad' }] },
          },
        }) as never,
    });

    await expect(lying.lanes.read(PROJECT)).rejects.toThrow('damaged');
  });
});

describe('the per-project board files over the state folder', () => {
  const PROJECT = '0b1f6d1e-6c1b-4f0c-8f4e-2f6f2a3c9a10' as BoardProjectId;

  test('a switch and a lane set are written into one file per project and each reads what the other left', async () => {
    const files = new BoardFiles(new MemoryStateFolder().port([BOARDS]), BOARDS as never);
    const switches = new BoardSwitchFiles(files);
    const lanes = new LaneSetFiles(files);

    expect(await switches.read(PROJECT)).toBeNull();
    expect(await lanes.read(PROJECT)).toBeNull();
    const stored = await switches.set(PROJECT, true, '2026-11-01T12:00:00.000Z');

    expect(stored).toEqual({ projectId: PROJECT, on: true, setBy: 'owner', setAt: '2026-11-01T12:00:00.000Z' });
    expect(await switches.read(PROJECT)).toEqual(stored);
    expect(await lanes.read(PROJECT)).toBeNull();
  });

  test('a damaged board file is refused by the switches and the lane sets with their own errors and is never overwritten', async () => {
    const folder = new MemoryStateFolder();
    const files = new BoardFiles(folder.port([BOARDS]), BOARDS as never);
    folder.plant(BOARDS as never, '{ not json', PROJECT);

    await expect(new BoardSwitchFiles(files).read(PROJECT)).rejects.toThrow();
    await expect(new BoardSwitchFiles(files).set(PROJECT, true, '2026-11-01T12:00:00.000Z')).rejects.toThrow();
    await expect(new LaneSetFiles(files).read(PROJECT)).rejects.toThrow();
    expect(folder.raw(BOARDS as never, PROJECT)).toBe('{ not json');
  });
});
