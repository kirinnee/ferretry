import { describe, expect, test } from 'bun:test';
import type { AskDraft, AskRef, AskSummary } from '@ferretry/core-asks/contract';
import type { PromptWaitRecord } from '../../../contract/index.ts';
import {
  PromptAsks,
  type PromptAsksPort,
  type PromptRecords,
  type PromptRoster,
} from '../../../daemon/prompts/adapters/prompt-asks.ts';
import { promptEntry, type PromptRead } from '../../../daemon/prompts/lib/prompt-wait.ts';

const permission = { id: '0123456789abcdef', tool: 'Bash', what: 'ls', question: 'Do you want to proceed?' };
const parked = (id = permission.id): PromptRead => ({
  turnState: 'needs-input',
  permissionRequest: { ...permission, id },
});
const working: PromptRead = { turnState: 'working' };

/**
 * Asks as far as prompt cards go, with Asks' own rules: `(source, entry)` is kept for life (a closed card's entry
 * returns the same ref and is never reopened), and a card raised for a ferret lands on `homeOf(ferret)`'s board.
 */
function board(
  options: { failRaise?: () => boolean; failClose?: () => boolean; homeOf?: (ferret: string) => string } = {},
) {
  const homeOf = options.homeOf ?? ((ferret: string) => ferret);
  const cards = new Map<string, { ref: AskRef; open: boolean; draft: AskDraft }>();
  const raises: AskDraft[] = [];
  const opens: string[] = [];
  const closes: { ref: AskRef; reason: string; entry: string | undefined }[] = [];
  let next = 0;
  const port: PromptAsksPort = {
    raise: async draft => {
      if (options.failRaise?.() === true) throw new Error('asks is down');
      raises.push(draft);
      const known = cards.get(String(draft.entry));
      if (known !== undefined) return known.ref;
      const ref = { ferret: homeOf(draft.ferret ?? ''), id: `A${++next}` } as AskRef;
      cards.set(String(draft.entry), { ref, open: true, draft });
      return ref;
    },
    close: async (ref, reason, entry) => {
      if (options.failClose?.() === true) throw new Error('asks is down');
      closes.push({ ref, reason, entry: entry === undefined ? undefined : String(entry) });
      for (const card of cards.values())
        if (card.ref.id === ref.id && card.ref.ferret === ref.ferret) card.open = false;
    },
    open: async filter => {
      opens.push(String(filter.entry));
      return [...cards.values()]
        .filter(card => card.open && (filter.entry === undefined || String(card.draft.entry) === String(filter.entry)))
        .map(card => ({ ferret: card.ref.ferret, id: card.ref.id }) as AskSummary);
    },
  };
  return { port, raises, closes, opens, open: () => [...cards.values()].filter(card => card.open) };
}

/** The records in memory, the way the plugin's state dir keeps them: they outlive any one `PromptAsks`. */
function records(): PromptRecords & { readonly files: Map<string, PromptWaitRecord>; readonly calls: string[] } {
  const files = new Map<string, PromptWaitRecord>();
  const calls: string[] = [];
  return {
    files,
    calls,
    list: async () => {
      calls.push('list');
      return [...files.keys()];
    },
    read: async ferret => files.get(ferret),
    write: async (ferret, record) => void files.set(ferret, record),
    remove: async ferret => void files.delete(ferret),
  };
}

const idle = (...ids: string[]): PromptRoster[] => ids.map(id => ({ id, state: 'idle' }));

function harness(options: Parameters<typeof board>[0] = {}, store = records()) {
  const asks = board(options);
  const said: string[] = [];
  const reads: string[] = [];
  const state: { read: (ferret: string) => PromptRead | undefined | Error } = { read: () => parked() };
  const make = () =>
    new PromptAsks(
      asks.port,
      async ferret => {
        reads.push(ferret);
        const read = state.read(ferret);
        if (read instanceof Error) throw read;
        return read;
      },
      store,
      message => said.push(message),
    );
  return { asks, said, reads, state, store, make, prompts: make() };
}

describe('a ferret parked on a prompt', () => {
  test('has one card raised for it, once however often it is looked at, and it is cleared when the wait ends', async () => {
    const { prompts, asks, state, store } = harness();

    await prompts.sweep(idle('f1'));
    await prompts.sweep(idle('f1'));

    expect(asks.raises).toHaveLength(1);
    expect(asks.open()).toHaveLength(1);
    expect(asks.raises[0]).toMatchObject({
      source: 'prompt',
      kind: 'task',
      subject: 'f1 needs a permission answer',
      context: 'Permission: Bash ls. Do you want to proceed?',
      ferret: 'f1',
      blocking: true,
      raisedBy: { kind: 'daemon' },
      ref: { kind: 'permission', prompt: permission.id },
      entry: promptEntry('f1', { kind: 'permission', prompt: permission.id }, 1),
    });
    expect(asks.closes).toEqual([]);

    state.read = () => working;
    await prompts.sweep(idle('f1'));
    expect(asks.closes.map(close => `${close.ref.ferret} ${close.reason} ${close.entry}`)).toEqual([
      `f1 withdrawn ${asks.raises[0]!.entry}`,
    ]);
    expect(store.files.get('f1')).toMatchObject({ waiting: false, occurrence: 1 });
    expect(store.files.get('f1')?.ask).toBeUndefined();
  });

  test('the same prompt again after a working turn is a new open card', async () => {
    const { prompts, asks, state } = harness();

    await prompts.sweep(idle('f1'));
    state.read = () => working;
    await prompts.sweep(idle('f1'));
    expect(asks.open()).toHaveLength(0);
    state.read = () => parked();
    prompts.changed('f1');
    await prompts.sweep(idle('f1'));

    expect(asks.open()).toHaveLength(1);
    expect(asks.open()[0]?.draft.entry).toBe(promptEntry('f1', { kind: 'permission', prompt: permission.id }, 2));
  });

  test('a changed prompt is a new card and the old one is closed', async () => {
    const { prompts, asks, state } = harness();

    await prompts.sweep(idle('f1'));
    state.read = () => parked('aaaaaaaaaaaaaaaa');
    await prompts.sweep(idle('f1'));

    expect(asks.open()).toHaveLength(1);
    expect(asks.closes).toHaveLength(1);
    expect(asks.open()[0]?.draft.ref).toEqual({ kind: 'permission', prompt: 'aaaaaaaaaaaaaaaa' });
  });

  test('keeps its card through a transient empty or failed reading, and recovers', async () => {
    const { prompts, asks, state, said } = harness();

    await prompts.sweep(idle('f1'));
    state.read = () => ({});
    await prompts.sweep(idle('f1'));
    state.read = () => undefined;
    await prompts.sweep(idle('f1'));
    state.read = () => new Error('state unreadable');
    await prompts.sweep(idle('f1'));
    await prompts.sweep(idle('f1'));
    expect(asks.open()).toHaveLength(1);
    expect(asks.closes).toEqual([]);
    expect(said).toHaveLength(1);

    state.read = () => parked();
    await prompts.sweep(idle('f1'));
    expect(asks.open()).toHaveLength(1);
    expect(asks.raises).toHaveLength(1);
    state.read = () => working;
    await prompts.sweep(idle('f1'));
    expect(asks.open()).toHaveLength(0);
  });

  test('two long prompts that share their first 239 characters get different cards', async () => {
    const { prompts, asks, state } = harness();
    const prefix = 'y'.repeat(300);

    state.read = () => ({ turnState: 'needs-input', prompt: `${prefix} first` });
    await prompts.sweep(idle('f1'));
    state.read = () => ({ turnState: 'needs-input', prompt: `${prefix} second` });
    await prompts.sweep(idle('f1'));

    expect(new Set(asks.raises.map(draft => draft.entry)).size).toBe(2);
    expect(asks.open()).toHaveLength(1);
    expect(asks.open()[0]?.draft.context).toBe(`${prefix} second`);
  });

  test('is not raised twice by a restart: a new sweeper finds the card the last one raised', async () => {
    const { prompts, asks, make } = harness();

    await prompts.sweep(idle('f1'));
    const restarted = make();
    await restarted.sweep(idle('f1'));
    await restarted.sweep(idle('f1'));

    expect(new Set(asks.raises.map(draft => draft.entry)).size).toBe(1);
    expect(asks.open()).toHaveLength(1);
  });

  test('is not raised twice when the daemon died between recording the wait and the card being recorded', async () => {
    let down = true;
    const { prompts, asks, make, store } = harness({ failRaise: () => down });

    await prompts.sweep(idle('f1'));
    expect(store.files.get('f1')).toMatchObject({ waiting: true, occurrence: 1 });
    expect(store.files.get('f1')?.ask).toBeUndefined();
    down = false;
    await make().sweep(idle('f1'));

    expect(asks.open()).toHaveLength(1);
    expect(store.files.get('f1')?.ask?.entry).toBe(asks.raises[0]!.entry);
  });

  test('a restart that finds the wait over closes the card the last run left', async () => {
    const { prompts, asks, make, state } = harness();

    await prompts.sweep(idle('f1'));
    state.read = () => working;
    await make().sweep(idle('f1'));

    expect(asks.open()).toHaveLength(0);
  });

  test('a sub-ferret’s card, which landed on its lead’s board, is closed by the ref it was raised with, when it stops waiting', async () => {
    const { prompts, asks, state } = harness({ homeOf: ferret => (ferret === 'child' ? 'lead' : ferret) });
    state.read = ferret => (ferret === 'child' ? parked() : working);
    const roster: PromptRoster[] = [
      { id: 'lead', state: 'working' },
      { id: 'child', state: 'idle' },
    ];

    await prompts.sweep(roster);
    await prompts.sweep(roster);
    expect(asks.open()).toHaveLength(1);
    expect(asks.open()[0]?.ref.ferret).toBe('lead');
    expect(asks.closes).toEqual([]);

    state.read = () => working;
    await prompts.sweep(roster);
    expect(asks.open()).toHaveLength(0);
    expect(asks.closes[0]?.ref.ferret).toBe('lead');
    expect(String(asks.closes[0]?.ref.id)).toBe('A1');
  });

  test('has its card closed when the ferret stops or goes away, and a stopped ferret is never read', async () => {
    const { prompts, asks, reads, store } = harness();

    await prompts.sweep(idle('f1', 'f2'));
    expect(asks.open()).toHaveLength(2);

    await prompts.sweep([{ id: 'f1', state: 'stopped' }, ...idle('f2')]);
    expect(asks.open().map(card => card.draft.ferret)).toEqual(['f2']);
    expect(store.files.get('f1')).toMatchObject({ waiting: false });

    await prompts.sweep([]);
    expect(asks.open()).toHaveLength(0);
    expect(store.files.has('f2')).toBe(false);
    expect(reads).toEqual(['f1', 'f2', 'f2']);
  });
});

describe('the work a look does', () => {
  test('is none when no ferret could be waiting and no card is owed: no pane is read, nothing is asked', async () => {
    const { prompts, asks, reads, store } = harness();
    const quiet: PromptRoster[] = [
      { id: 'a', state: 'working' },
      { id: 'b', state: 'starting' },
      { id: 'c', state: 'stopped' },
    ];

    await prompts.sweep(quiet);
    await prompts.sweep(quiet);

    expect(reads).toEqual([]);
    expect(asks.raises).toEqual([]);
    expect(asks.closes).toEqual([]);
    expect(store.calls).toEqual(['list']);
  });

  test('reads only an idle pane, and a ferret that is owed a card whatever it is doing now', async () => {
    const { prompts, reads, state } = harness();
    const roster: PromptRoster[] = [
      { id: 'a', state: 'working' },
      { id: 'b', state: 'idle' },
    ];

    await prompts.sweep(roster);
    expect(reads).toEqual(['b']);

    state.read = () => parked();
    await prompts.sweep([{ id: 'b', state: 'working' }]);
    expect(reads).toEqual(['b', 'b']);
  });

  test('a ferret that was idle at your turn, with no wait in it, is read but owed nothing', async () => {
    const { prompts, asks, state, store } = harness();
    state.read = () => ({ turnState: 'your-turn' });
    store.files.set('f1', { format: 1, key: 'permission:x', occurrence: 3, waiting: false });

    await prompts.sweep(idle('f1'));

    expect(asks.raises).toEqual([]);
    expect(asks.closes).toEqual([]);
    expect(store.files.get('f1')?.occurrence).toBe(3);
  });

  test('never asks Asks which cards are open while it holds their refs: it closes by them', async () => {
    const { prompts, asks, state } = harness();
    await prompts.sweep(idle('f1'));
    state.read = () => working;
    await prompts.sweep(idle('f1'));
    expect(asks.closes).toHaveLength(1);
    expect(asks.opens).toEqual([]);
  });
});

describe('a failing Asks or state', () => {
  test('a card that cannot be raised is said once, asked again by the next look, and does not stop the other ferrets', async () => {
    let attempts = 0;
    const { prompts, asks, said, state } = harness({ failRaise: () => ++attempts > 0 });
    state.read = ferret => (ferret === 'f1' ? new Error('pane unreadable') : parked());

    await prompts.sweep(idle('f1', 'f2'));
    await prompts.sweep(idle('f1', 'f2'));
    await prompts.sweep(idle('f1', 'f2'));

    expect(asks.open()).toEqual([]);
    expect(said).toHaveLength(2);
    expect(said[0]).toContain('f1');
    expect(said[0]).toContain('pane unreadable');
    expect(said[1]).toContain('f2');
    expect(attempts).toBe(3);
  });

  test('a card that cannot be closed is said once and closed by the look that can', async () => {
    let down = false;
    const { prompts, asks, said, state } = harness({ failClose: () => down });
    await prompts.sweep(idle('f1'));
    state.read = () => working;
    down = true;
    await prompts.sweep(idle('f1'));
    await prompts.sweep(idle('f1'));
    await prompts.sweep(idle('f1'));
    expect(said).toHaveLength(1);
    expect(asks.open()).toHaveLength(1);

    down = false;
    await prompts.sweep(idle('f1'));
    expect(asks.open()).toHaveLength(0);
  });

  test('says it again once it worked in between', async () => {
    const { prompts, said, state } = harness();
    state.read = () => new Error('pane unreadable');

    await prompts.sweep(idle('f1'));
    state.read = () => ({ turnState: 'your-turn' }); // a POSITIVE reading: an unknown one is not "it worked"
    await prompts.sweep(idle('f1'));
    state.read = () => new Error('pane unreadable');
    prompts.changed('f1');
    await prompts.sweep(idle('f1'));

    expect(said).toHaveLength(2);
  });

  test('a ferret that stops being looked at while failing is forgotten, so its next failure is said', async () => {
    const { prompts, said, state } = harness();
    state.read = () => new Error('pane unreadable');

    await prompts.sweep(idle('f1'));
    await prompts.sweep([{ id: 'f1', state: 'working' }]);
    prompts.changed('f1');
    await prompts.sweep(idle('f1'));

    expect(said).toHaveLength(2);
  });

  test('records that cannot be read are said once, nothing is raised, and the next look tries again', async () => {
    const store = records();
    let broken = true;
    const read = store.read;
    store.read = async ferret => {
      if (broken) throw new Error('prompt-wait.json is damaged');
      return await read(ferret);
    };
    store.files.set('f1', { format: 1, key: 'permission:x', occurrence: 1, waiting: false });
    const { prompts, asks, said } = harness({}, store);

    await prompts.sweep(idle('f1'));
    await prompts.sweep(idle('f1'));
    expect(asks.raises).toEqual([]);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('damaged');

    broken = false;
    await prompts.sweep(idle('f1'));
    expect(asks.open()).toHaveLength(1);
    expect(store.files.get('f1')?.occurrence).toBe(2);
  });
});

describe('what a tick reads', () => {
  const twenty = Array.from({ length: 20 }, (_, i) => `f${i}`);

  test('twenty idle your-turn ferrets with no events cost one reconciliation, then no read per tick', async () => {
    const { prompts, reads, state } = harness();
    state.read = () => ({ turnState: 'your-turn' });

    await prompts.sweep(idle(...twenty));
    expect(reads).toHaveLength(20);
    await prompts.sweep(idle(...twenty));
    await prompts.sweep(idle(...twenty));
    expect(reads).toHaveLength(20);
  });

  test('an event for one ferret is exactly one read, and only on the next sweep', async () => {
    const { prompts, reads, state } = harness();
    state.read = () => ({ turnState: 'your-turn' });
    await prompts.sweep(idle(...twenty));
    reads.length = 0;

    prompts.changed('f7');
    expect(reads).toEqual([]);
    await prompts.sweep(idle(...twenty));
    expect(reads).toEqual(['f7']);
    await prompts.sweep(idle(...twenty));
    expect(reads).toEqual(['f7']);
  });

  test('a changed ferret whose first reading is unknown (the real service returns {}) is read again until a positive reading', async () => {
    const { prompts, asks, reads, state, said } = harness();
    state.read = () => ({ turnState: 'your-turn' });
    await prompts.sweep(idle('f1', 'f2'));
    reads.length = 0;

    state.read = () => ({});
    prompts.changed('f1');
    await prompts.sweep(idle('f1', 'f2'));
    await prompts.sweep(idle('f1', 'f2'));
    expect(reads).toEqual(['f1', 'f1']); // one read per sweep, and no other ferret
    expect(asks.raises).toHaveLength(0);
    expect(said).toEqual([]); // an unknown reading is not a failure

    state.read = () => parked();
    await prompts.sweep(idle('f1', 'f2'));
    await prompts.sweep(idle('f1', 'f2'));
    expect(asks.raises).toHaveLength(1);
    expect(asks.open()).toHaveLength(1);
  });

  test('a positive empty reading ends the retry: no read per tick forever', async () => {
    const { prompts, reads, state } = harness();
    state.read = () => ({});
    prompts.changed('f1');
    await prompts.sweep(idle('f1'));
    state.read = () => ({ turnState: 'your-turn' });
    await prompts.sweep(idle('f1'));
    reads.length = 0;

    await prompts.sweep(idle('f1'));
    await prompts.sweep(idle('f1'));
    expect(reads).toEqual([]);
  });

  test('an unknown reading of a ferret nobody reported changed is not retried every tick', async () => {
    const { prompts, reads, state } = harness();
    state.read = () => ({});
    await prompts.sweep(idle('f1'));
    reads.length = 0;

    await prompts.sweep(idle('f1'));
    await prompts.sweep(idle('f1'));
    expect(reads).toEqual([]);
  });

  test('an event for a ferret that is working, stopped or unknown reads nothing', async () => {
    const { prompts, reads, state } = harness();
    state.read = () => ({ turnState: 'your-turn' });
    await prompts.sweep(idle('f1'));
    reads.length = 0;

    prompts.changed('f1');
    prompts.changed('gone');
    await prompts.sweep([
      { id: 'f1', state: 'working' },
      { id: 'f2', state: 'stopped' },
    ]);
    expect(reads).toEqual([]);
  });

  test('a ferret owed a card is read on every tick until the wait ends, and no other is', async () => {
    const { prompts, reads, state } = harness();
    state.read = () => ({ turnState: 'your-turn' });
    await prompts.sweep(idle('f1', 'f2'));
    state.read = ferret => (ferret === 'f1' ? parked() : { turnState: 'your-turn' });
    prompts.changed('f1');
    await prompts.sweep(idle('f1', 'f2'));
    reads.length = 0;

    await prompts.sweep(idle('f1', 'f2'));
    await prompts.sweep(idle('f1', 'f2'));
    expect(reads).toEqual(['f1', 'f1']);
  });

  test('an event that arrives while a sweep is looking is kept for the next sweep', async () => {
    const { prompts, reads, state } = harness();
    state.read = () => ({ turnState: 'your-turn' });
    await prompts.sweep(idle('f1', 'f2'));
    reads.length = 0;
    state.read = ferret => {
      if (ferret === 'f1') prompts.changed('f2');
      return { turnState: 'your-turn' };
    };

    prompts.changed('f1');
    await prompts.sweep(idle('f1', 'f2'));
    expect(reads).toEqual(['f1']);
    await prompts.sweep(idle('f1', 'f2'));
    expect(reads).toEqual(['f1', 'f2']);
  });

  test('a look that failed is asked again by the next tick without a new event', async () => {
    const { prompts, reads, state } = harness();
    await prompts.sweep(idle('f1'));
    reads.length = 0;
    state.read = () => new Error('pane unreadable');
    prompts.changed('f1');

    await prompts.sweep(idle('f1'));
    await prompts.sweep(idle('f1'));
    expect(reads).toEqual(['f1', 'f1']);
  });
});

describe('a card whose ref was never saved', () => {
  /** Asks raised, then the ref could not be saved: the record says waiting, with no card. */
  async function unsaved(options: Parameters<typeof board>[0] = {}) {
    const store = records();
    const write = store.write;
    let lose = true;
    store.write = async (ferret, record) => {
      if (lose && record.ask !== undefined) {
        lose = false;
        throw new Error('disk full');
      }
      await write(ferret, record);
    };
    const made = harness(options, store);
    made.prompts.changed('f1');
    await made.prompts.sweep(idle('f1'));
    expect(made.asks.open()).toHaveLength(1);
    expect(store.files.get('f1')).toMatchObject({ waiting: true, occurrence: 1 });
    expect(store.files.get('f1')?.ask).toBeUndefined();
    return made;
  }

  test('is found by its entry and closed where it landed, when the wait ends', async () => {
    const made = await unsaved({ homeOf: () => 'lead' });
    made.state.read = () => working;
    await made.prompts.sweep(idle('f1'));

    expect(made.asks.open()).toHaveLength(0);
    expect(made.asks.opens).toEqual([String(made.asks.raises[0]!.entry)]);
    expect(made.asks.closes.map(close => `${close.ref.ferret} ${close.ref.id} ${close.reason} ${close.entry}`)).toEqual(
      [`lead A1 withdrawn ${made.asks.raises[0]!.entry}`],
    );
    expect(made.store.files.get('f1')).toMatchObject({ waiting: false, occurrence: 1 });
  });

  test('a wait that never raised anything closes nothing', async () => {
    const made = harness({ failRaise: () => true });
    made.prompts.changed('f1');
    await made.prompts.sweep(idle('f1'));
    expect(made.store.files.get('f1')).toMatchObject({ waiting: true });
    made.state.read = () => working;
    await made.prompts.sweep(idle('f1'));

    expect(made.asks.closes).toEqual([]);
    expect(made.store.files.get('f1')).toMatchObject({ waiting: false });
  });

  test('is found again when a failed lookup is retried', async () => {
    let down = true;
    const made = await unsaved();
    const open = made.asks.port.open;
    made.asks.port.open = async filter => {
      if (down) throw new Error('asks is down');
      return await open(filter);
    };
    made.state.read = () => working;
    await made.prompts.sweep(idle('f1'));
    expect(made.asks.open()).toHaveLength(1);
    expect(made.said).toHaveLength(1);

    down = false;
    await made.prompts.sweep(idle('f1'));
    expect(made.asks.open()).toHaveLength(0);
  });

  test('a steady tick never looks for it: only a record that is cleared does', async () => {
    const made = await unsaved();
    expect(made.asks.opens).toEqual([]);
    await made.prompts.sweep(idle('f1'));
    expect(made.asks.opens).toEqual([]);
  });

  test('a record whose key names no wait is cleared without a lookup', async () => {
    const store = records();
    store.files.set('f1', { format: 1, key: 'nonsense', occurrence: 1, waiting: true });
    const made = harness({}, store);
    made.state.read = () => working;
    await made.prompts.sweep(idle('f1'));

    expect(made.asks.opens).toEqual([]);
    expect(store.files.get('f1')).toMatchObject({ waiting: false });
  });
});

describe('a raise that succeeded but whose ref was never saved, on its own board and redirected to a lead', () => {
  /** Asks raised and kept the card; the process lost the write that would have saved its ref. */
  const losingFirstRefSave = (store: ReturnType<typeof records>): ReturnType<typeof records> => {
    const write = store.write;
    let armed = true;
    store.write = async (ferret, record) => {
      if (armed && record.ask !== undefined) {
        armed = false;
        throw new Error('lost before the ref was saved');
      }
      await write(ferret, record);
    };
    return store;
  };
  const homeOf = (ferret: string): string => (ferret === 'child' ? 'lead' : ferret);

  for (const [name, ferret, roster, home] of [
    ['on its own board', 'f1', idle('f1'), undefined],
    [
      'redirected from a child to its lead',
      'child',
      [
        { id: 'lead', state: 'working' },
        { id: 'child', state: 'idle' },
      ] satisfies PromptRoster[],
      homeOf,
    ],
  ] as const) {
    test(`is closed when the wait ends: zero open, then one open on the next occurrence (${name})`, async () => {
      const { prompts, asks, state } = harness(
        home === undefined ? {} : { homeOf: home },
        losingFirstRefSave(records()),
      );
      prompts.changed(ferret);
      await prompts.sweep(roster);
      expect(asks.open()).toHaveLength(1);

      state.read = () => working;
      await prompts.sweep(roster);
      expect(asks.open()).toHaveLength(0);

      state.read = () => parked();
      prompts.changed(ferret);
      await prompts.sweep(roster);
      expect(asks.open()).toHaveLength(1);
    });

    test(`is closed when the wait ends after a daemon restart (${name})`, async () => {
      const made = harness(home === undefined ? {} : { homeOf: home }, losingFirstRefSave(records()));
      made.prompts.changed(ferret);
      await made.prompts.sweep(roster);
      expect(made.asks.open()).toHaveLength(1);

      const restarted = made.make();
      made.state.read = () => working;
      await restarted.sweep(roster);
      expect(made.asks.open()).toHaveLength(0);
      expect(made.asks.closes.map(close => close.ref.ferret)).toEqual([home?.(ferret) ?? ferret]);
    });
  }

  test('is closed when its ferret goes away', async () => {
    const { prompts, asks, store } = harness({}, losingFirstRefSave(records()));
    prompts.changed('f1');
    await prompts.sweep(idle('f1'));
    expect(asks.open()).toHaveLength(1);

    await prompts.sweep([]);
    expect(asks.open()).toHaveLength(0);
    expect(store.files.has('f1')).toBe(false);
  });

  test('is closed when another prompt replaces its wait, and the new one is its own card', async () => {
    const { prompts, asks, state } = harness({}, losingFirstRefSave(records()));
    prompts.changed('f1');
    await prompts.sweep(idle('f1'));

    state.read = () => parked('aaaaaaaaaaaaaaaa');
    await prompts.sweep(idle('f1'));
    expect(asks.open()).toHaveLength(1);
    expect(asks.open()[0]?.draft.ref).toEqual({ kind: 'permission', prompt: 'aaaaaaaaaaaaaaaa' });
  });
});
