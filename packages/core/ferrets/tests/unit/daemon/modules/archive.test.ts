import { describe, expect, test } from 'bun:test';
import type { StatePort } from '@ferretry/kernel/contract';
import { MemoryStateFolder } from '@ferretry/kernel/testing';
import {
  ArchiveFile,
  ArchiveKeeps,
  type ArchiveKeepSource,
  FERRET_STATES,
  type FerretId,
} from '../../../../contract/index.ts';
import { DaemonStorage } from '../../../../daemon/adapters/storage/session-storage.ts';
import {
  ARCHIVE_ANSWER_TIMEOUT_MS,
  ARCHIVE_KEEPS_DEADLINE_MS,
  ARCHIVE_PASS_EVERY_MS,
  ARCHIVE_TICK_MS,
  archiveAfterMs,
  buildArchive,
  hiddenFromLiveList,
} from '../../../../daemon/modules/archive.ts';
import { parseSessionId } from '../../../../daemon/lib/session-id.ts';
import { RecordingLog, SESSION_STORE_FILES, sessionConfig, sessionState } from '../../../support/daemon/storage.ts';

/**
 * The archive module on its own: the cadence the kernel job keeps (J-0185), and the paths where a pass fails, over the
 * real session store on a memory state folder.
 */

const T0 = Date.parse('2026-11-06T12:00:00.000Z');
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

const board: ArchiveKeepSource = { kind: 'board', cards: async () => [] };
const fid = (id: string) => id as FerretId;

/** The answer bound's timers, fired by hand: what is pending, and what was cancelled. */
class Timers {
  readonly pending = new Map<number, { readonly delayMs: number; readonly fire: () => void }>();
  private next = 0;
  readonly after = (delayMs: number, fire: () => void): (() => void) => {
    this.next += 1;
    const id = this.next;
    this.pending.set(id, { delayMs, fire });
    return () => this.pending.delete(id);
  };
  /** Fires what is due within `maxMs` (every timer this archive arms is at most 10 s), and nothing set further out. */
  fireWithin(maxMs: number): void {
    for (const [id, timer] of [...this.pending]) {
      if (timer.delayMs > maxMs) continue;
      this.pending.delete(id);
      timer.fire();
    }
  }
  fireAll(): void {
    for (const [id, timer] of [...this.pending]) {
      this.pending.delete(id);
      timer.fire();
    }
  }
}
const agenda: ArchiveKeepSource = { kind: 'agenda', hasOpenItem: async () => false };

/** A session store holding `ids` as autonomous ferrets that ended `endedHoursAgo` before T0. */
async function world(
  ids: readonly string[],
  options: { readonly endedHoursAgo?: number; readonly port?: (port: StatePort) => StatePort } = {},
) {
  const folder = new MemoryStateFolder();
  const base = folder.port(SESSION_STORE_FILES);
  const state = options.port?.(base) ?? base;
  const log = new RecordingLog();
  const storage = new DaemonStorage(state, { now: () => iso(T0) }, log);
  await storage.loadArchive();
  const ended = iso(T0 - (options.endedHoursAgo ?? 48) * HOUR);
  for (const id of ids) {
    await storage.writeConfig(
      parseSessionId(id),
      sessionConfig(id, { mode: 'auto', createdAt: ended, updatedAt: ended, teammate: id.slice(0, 5) }),
    );
    await storage.writeState(parseSessionId(id), sessionState(id, { status: 'stopped', finishedAt: ended }));
  }
  return { storage, folder, log };
}

function mount(
  w: Awaited<ReturnType<typeof world>>,
  clock: { now: number },
  more: {
    readonly afterHours?: number;
    readonly keeps?: readonly ArchiveKeepSource[];
    readonly passLimit?: number;
    readonly isLive?: (id: string) => boolean;
    readonly timers?: Timers;
    readonly loaded?: () => Promise<unknown>;
  } = {},
) {
  return buildArchive({
    storage: w.storage,
    settings: () => ({ afterHours: more.afterHours ?? 24 }),
    nowMs: () => clock.now,
    pinned: async () => new Map(),
    keeps: () => more.keeps ?? [board, agenda],
    isLive: more.isLive ?? (() => false),
    loaded: more.loaded ?? (async () => undefined),
    yieldToLoop: async () => undefined,
    directory: id => `sessions/${id}`,
    after: (more.timers ?? new Timers()).after,
    log: w.log,
    ...(more.passLimit === undefined ? {} : { passLimit: more.passLimit }),
  });
}

describe('the setting', () => {
  test('archiveAfterMs reads whole hours, and absent or off is off', () => {
    expect(archiveAfterMs({ afterHours: 24 })).toBe(24 * HOUR);
    expect(archiveAfterMs({ afterHours: 1 })).toBe(HOUR);
    expect(archiveAfterMs({ afterHours: 'off' })).toBeUndefined();
    expect(archiveAfterMs({})).toBeUndefined();
    expect(archiveAfterMs(undefined)).toBeUndefined();
  });
});

describe('J-0185 the archive pass is a kernel job that runs a pass only when one is due', () => {
  test('J-0185 a pass that finishes everything is followed in an hour, not before; one that left sessions behind in a minute', async () => {
    const w = await world(['aa-1', 'bb-1', 'cc-1']);
    const clock = { now: T0 };
    const archive = mount(w, clock, { passLimit: 2 });
    const archivedNow = (): number => w.storage.archivedCount();

    // The first tick is due at once: two of three leave (the pass bound), one is left behind.
    await archive.tick();
    expect(archivedNow()).toBe(2);
    // A tick a minute later is not due before the deferred pass's minute: one second short does nothing.
    clock.now += ARCHIVE_TICK_MS - 1_000;
    await archive.tick();
    expect(archivedNow()).toBe(2);
    // The minute is up: the pass that was cut at the bound takes the rest.
    clock.now += 1_000;
    await archive.tick();
    expect(archivedNow()).toBe(3);

    // Nothing was left behind, so the next pass is an hour away: a session that ends meanwhile waits for it.
    const ended = iso(clock.now - 48 * HOUR);
    await w.storage.writeConfig(
      parseSessionId('ee-1'),
      sessionConfig('ee-1', { mode: 'auto', createdAt: ended, updatedAt: ended }),
    );
    await w.storage.writeState(parseSessionId('ee-1'), sessionState('ee-1', { status: 'stopped', finishedAt: ended }));
    clock.now += ARCHIVE_PASS_EVERY_MS - 1_000;
    await archive.tick();
    expect(archivedNow()).toBe(3);
    clock.now += 1_000;
    await archive.tick();
    expect(archivedNow()).toBe(4);
  });

  test('J-0185 a tick that is not due reads nothing: no document of any session is asked for', async () => {
    const w = await world(['aa-1']);
    const clock = { now: T0 };
    let asked = 0;
    const counting: ArchiveKeepSource = {
      kind: 'agenda',
      hasOpenItem: async () => {
        asked += 1;
        return false;
      },
    };
    const archive = mount(w, clock, { keeps: [board, counting] });
    await archive.tick();
    const first = asked;
    expect(first).toBeGreaterThan(0);
    for (let tick = 0; tick < 50; tick += 1) {
      clock.now += ARCHIVE_TICK_MS;
      if (clock.now - T0 >= ARCHIVE_PASS_EVERY_MS) break;
      await archive.tick();
    }
    expect(asked).toBe(first);
  });

  test('off, and a pass that is not due, read nothing and archive nothing', async () => {
    const w = await world(['aa-1']);
    const off = buildArchive({
      storage: w.storage,
      settings: () => ({ afterHours: 'off' }),
      nowMs: () => T0,
      pinned: async () => new Map(),
      keeps: () => [board, agenda],
      isLive: () => false,
      loaded: async () => undefined,
      yieldToLoop: async () => undefined,
      directory: id => `sessions/${id}`,
      after: new Timers().after,
      log: w.log,
    });
    await off.tick();
    expect(w.storage.archivedCount()).toBe(0);
  });
});

describe('a pass that fails leaves every session live', () => {
  test('a registry write that fails archives nothing, says so, and the next pass an hour later archives it', async () => {
    let failing = true;
    const w = await world(['aa-1'], {
      port: port =>
        ({
          ...port,
          write: async (file: Parameters<StatePort['write']>[0], ...rest: unknown[]) => {
            if (failing && file === ArchiveFile) throw new Error('disk full');
            return await (port.write as (...args: unknown[]) => Promise<unknown>)(file, ...rest);
          },
        }) as StatePort,
    });
    const clock = { now: T0 };
    const archive = mount(w, clock);

    await archive.tick();
    expect(w.storage.archivedCount()).toBe(0);
    expect(w.storage.listSessions().map(row => String(row.id))).toEqual(['aa-1']);
    expect(w.log.lines.some(line => line.level === 'warn' && line.message.includes('every ferret stays live'))).toBe(
      true,
    );
    // Not tried again in a loop: a minute later it is not due.
    failing = false;
    clock.now += ARCHIVE_TICK_MS;
    await archive.tick();
    expect(w.storage.archivedCount()).toBe(0);
    // An hour after the failure it is.
    clock.now += ARCHIVE_PASS_EVERY_MS;
    await archive.tick();
    expect(w.storage.archivedCount()).toBe(1);
    // And the session's documents were never touched by the failed attempt.
    expect(await w.storage.readState(parseSessionId('aa-1'))).toMatchObject({ status: 'stopped' });
  });
});

describe('a ferret the daemon still holds running is never archived', () => {
  test('whatever its document says, a ferret the registry holds live stays', async () => {
    const w = await world(['aa-1', 'bb-1']);
    const archive = mount(w, { now: T0 }, { isLive: id => id === 'aa-1' });
    await archive.tick();
    expect(w.storage.listArchivedSessions().map(row => String(row.id))).toEqual(['bb-1']);
    expect(w.storage.listSessions().map(row => String(row.id))).toEqual(['aa-1']);
  });
});

describe('Board and Agenda must both have answered', () => {
  test.each([
    ['only Board', [board]],
    ['only Agenda', [agenda]],
    ['neither', []],
  ])('%s: no pass runs', async (_name, keeps) => {
    const w = await world(['aa-1']);
    const archive = mount(w, { now: T0 }, { keeps });
    await archive.tick();
    expect(w.storage.archivedCount()).toBe(0);
  });

  test('a Board that fails keeps every ferret, and one that says a ferret is on an open card keeps that one', async () => {
    const w = await world(['aa-1', 'bb-1']);
    const failing: ArchiveKeepSource = {
      kind: 'board',
      cards: async () => {
        throw new Error('unreadable');
      },
    };
    await mount(w, { now: T0 }, { keeps: [failing, agenda] }).tick();
    expect(w.storage.archivedCount()).toBe(0);

    const holding: ArchiveKeepSource = {
      kind: 'board',
      cards: async () => [{ owner: fid('aa-1'), assignee: null, dropped: false, category: 'review' }],
    };
    await mount(w, { now: T0 }, { keeps: [holding, agenda] }).tick();
    expect(w.storage.listArchivedSessions().map(row => String(row.id))).toEqual(['bb-1']);
  });

  test('a dropped card holds nobody, and a card of a closed lane holds nobody', async () => {
    const w = await world(['aa-1', 'bb-1']);
    const cards: ArchiveKeepSource = {
      kind: 'board',
      cards: async () => [
        { owner: fid('aa-1'), assignee: null, dropped: true, category: 'active' },
        { owner: fid('bb-1'), assignee: null, dropped: false, category: 'closed' },
      ],
    };
    await mount(w, { now: T0 }, { keeps: [cards, agenda] }).tick();
    expect(w.storage.listArchivedSessions().map(row => String(row.id))).toEqual(['aa-1', 'bb-1']);
  });
});

/** Lets the pass run until it waits on an answer (its timer is armed), or gives up. */
async function untilAsked(timers: Timers): Promise<void> {
  for (let turn = 0; turn < 500 && timers.pending.size === 0; turn += 1) await Bun.sleep(0);
  if (timers.pending.size === 0) throw new Error('the pass never asked');
}

describe('a garbage answer from Board or Agenda never archives (parsed at the Ferrets boundary)', () => {
  /** A Board that answers `raw`, as a plugin of any quality might: the types say nothing about what really comes back. */
  const boardSaying = (raw: unknown): ArchiveKeepSource => ({
    kind: 'board',
    cards: (async () => raw) as unknown as () => Promise<never>,
  });
  const agendaSaying = (raw: unknown): ArchiveKeepSource => ({
    kind: 'agenda',
    hasOpenItem: (async () => raw) as unknown as () => Promise<boolean>,
  });

  test('the control: a well-formed answer that keeps nobody archives (so every case below can go red)', async () => {
    const w = await world(['aa-1']);
    await mount(w, { now: T0 }, { keeps: [boardSaying([]), agendaSaying(false)] }).tick();
    expect(w.storage.archivedCount()).toBe(1);
  });

  test.each([
    ['an object, not a list', { cards: [{ owner: 'aa-1', assignee: null, dropped: false, category: 'active' }] }],
    ['undefined', undefined],
    ['null', null],
    ['a string', 'aa-1'],
    ['a list of strings', ['aa-1']],
    ['a card with no owner', [{ assignee: null, dropped: false, category: 'active' }]],
    ['a card whose owner is not a ferret id', [{ owner: 'a b/../c', assignee: null, dropped: false }]],
    ['a card with no assignee key', [{ owner: 'zz-9', dropped: false, category: 'active' }]],
    ['a dropped that is the string "false"', [{ owner: 'aa-1', assignee: null, dropped: 'false', category: 'active' }]],
    ['a dropped that is 0', [{ owner: 'aa-1', assignee: null, dropped: 0, category: 'active' }]],
    ['a category that is a number', [{ owner: 'zz-9', assignee: null, dropped: false, category: 3 }]],
    ['a card with a field the contract does not name', [{ owner: 'zz-9', assignee: null, dropped: false, extra: 1 }]],
  ])('Board answering %s keeps every ferret', async (_name, raw) => {
    const w = await world(['aa-1']);
    await mount(w, { now: T0 }, { keeps: [boardSaying(raw), agendaSaying(false)] }).tick();
    expect(w.storage.archivedCount()).toBe(0);
  });

  test.each([
    ['undefined', undefined],
    ['null', null],
    ['0', 0],
    ['1', 1],
    ['the string "false"', 'false'],
    ['an empty string', ''],
    ['an object', {}],
    ['a list', []],
  ])('Agenda answering %s keeps the ferret', async (_name, raw) => {
    const w = await world(['aa-1']);
    await mount(w, { now: T0 }, { keeps: [boardSaying([]), agendaSaying(raw)] }).tick();
    expect(w.storage.archivedCount()).toBe(0);
  });

  test('a Board whose cards() throws synchronously keeps every ferret, and so does an Agenda that does', async () => {
    const w = await world(['aa-1']);
    const throwing = (): never => {
      throw new Error('not even a promise');
    };
    await mount(w, { now: T0 }, { keeps: [{ kind: 'board', cards: throwing }, agendaSaying(false)] }).tick();
    expect(w.storage.archivedCount()).toBe(0);
    await mount(w, { now: T0 }, { keeps: [boardSaying([]), { kind: 'agenda', hasOpenItem: throwing }] }).tick();
    expect(w.storage.archivedCount()).toBe(0);
  });

  test('a Board that never answers keeps every ferret once its answer is late', async () => {
    const w = await world(['aa-1']);
    const timers = new Timers();
    const hanging: ArchiveKeepSource = { kind: 'board', cards: async () => await new Promise<never>(() => {}) };
    const ticking = mount(w, { now: T0 }, { keeps: [hanging, agendaSaying(false)], timers }).tick();
    await untilAsked(timers);
    // The question's own bound, and the one deadline of the whole check that holds it.
    expect([...timers.pending.values()].map(timer => timer.delayMs)).toEqual([
      ARCHIVE_KEEPS_DEADLINE_MS,
      ARCHIVE_ANSWER_TIMEOUT_MS,
    ]);
    timers.fireAll();
    await ticking;
    expect(w.storage.archivedCount()).toBe(0);
  });

  test('an Agenda that never answers keeps the ferret once its answer is late', async () => {
    const w = await world(['aa-1']);
    const timers = new Timers();
    const hanging: ArchiveKeepSource = { kind: 'agenda', hasOpenItem: async () => await new Promise<never>(() => {}) };
    const ticking = mount(w, { now: T0 }, { keeps: [boardSaying([]), hanging], timers }).tick();
    await untilAsked(timers);
    timers.fireAll();
    await ticking;
    expect(w.storage.archivedCount()).toBe(0);
  });

  test('an answer that comes in time cancels its bound: no timer outlives the pass', async () => {
    const w = await world(['aa-1', 'bb-1']);
    const timers = new Timers();
    await mount(w, { now: T0 }, { keeps: [boardSaying([]), agendaSaying(false)], timers }).tick();
    expect(w.storage.archivedCount()).toBe(2);
    expect(timers.pending.size).toBe(0);
  });

  test('the hook refuses an item that is not a keep source, so a garbage contribution is no answer at all', () => {
    const fits = (item: unknown): boolean => ArchiveKeeps.item?.safeParse(item).success === true;
    expect(fits(board)).toBe(true);
    expect(fits(agenda)).toBe(true);
    expect(fits(undefined)).toBe(false);
    expect(fits(null)).toBe(false);
    expect(fits({ kind: 'board' })).toBe(false);
    expect(fits({ kind: 'board', cards: [] })).toBe(false);
    expect(fits({ kind: 'agenda', hasOpenItem: true })).toBe(false);
    expect(fits({ kind: 'agenda', cards: async () => [] })).toBe(false);
    expect(fits({ kind: 'warden', cards: async () => [] })).toBe(false);
  });
});

describe('a store whose archive did not load', () => {
  test('fails the pass like any other failure: no rejection out of the tick, a warning, and the next try an hour later', async () => {
    const w = await world(['aa-1']);
    const clock = { now: T0 };
    let loads = 0;
    const archive = mount(w, clock, {
      loaded: async () => {
        loads += 1;
        throw new Error('the archive registry is damaged');
      },
    });
    await archive.tick();
    expect(w.storage.archivedCount()).toBe(0);
    expect(w.log.lines.some(line => line.level === 'warn' && line.message.includes('every ferret stays live'))).toBe(
      true,
    );
    clock.now += ARCHIVE_TICK_MS;
    await archive.tick();
    expect(loads).toBe(1);
    clock.now += ARCHIVE_PASS_EVERY_MS;
    await archive.tick();
    expect(loads).toBe(2);
  });
});

describe('the archive module: hiddenFromLiveList and the check deadline (u6-r2)', () => {
  test.each(FERRET_STATES.map(state => [state] as const))(
    'a %s ferret is left out of the live list only when it is archived and stopped',
    state => {
      expect(hiddenFromLiveList(state, false)).toBe(false);
      expect(hiddenFromLiveList(state, true)).toBe(state === 'stopped');
    },
  );

  test('ONE deadline covers a whole keeps check: more ferrets than one batch are kept when it fires, with no second round of timers', async () => {
    const ids = Array.from({ length: 20 }, (_, at) => `aa-${String(at)}`);
    const w = await world(ids);
    const timers = new Timers();
    let asked = 0;
    const hanging: ArchiveKeepSource = {
      kind: 'agenda',
      hasOpenItem: async () => {
        asked += 1;
        return await new Promise<never>(() => {});
      },
    };
    const ticking = mount(w, { now: T0 }, { keeps: [board, hanging], timers }).tick();
    await untilAsked(timers);
    expect(timers.pending.size).toBeGreaterThan(0);
    // One firing of the timers that are due ends the pass: nothing is left waiting for another round of 10 s.
    timers.fireWithin(ARCHIVE_KEEPS_DEADLINE_MS);
    await ticking;
    // The second batch of Agenda reads is never asked: the deadline stopped the check, not the question timers.
    await Bun.sleep(5);
    expect(asked).toBe(8);
    expect(w.storage.archivedCount()).toBe(0);
    expect(timers.pending.size).toBe(0);
  });

  test('a stopped job ends a pass that is waiting on a hung Agenda: nothing archived, no timer left behind', async () => {
    const w = await world(['aa-1']);
    const timers = new Timers();
    const hanging: ArchiveKeepSource = { kind: 'agenda', hasOpenItem: async () => await new Promise<never>(() => {}) };
    const controller = new AbortController();
    const ticking = mount(w, { now: T0 }, { keeps: [board, hanging], timers }).tick(controller.signal);
    await untilAsked(timers);
    controller.abort();
    await ticking;
    expect(w.storage.archivedCount()).toBe(0);
    // The check's own deadline is cancelled; only the hung question's bound is left to lapse on its own.
    expect([...timers.pending.values()].map(timer => timer.delayMs)).toEqual([ARCHIVE_ANSWER_TIMEOUT_MS]);
  });

  test('a job already stopped starts no pass at all', async () => {
    const w = await world(['aa-1']);
    const controller = new AbortController();
    controller.abort();
    let asked = 0;
    const counting: ArchiveKeepSource = {
      kind: 'agenda',
      hasOpenItem: async () => {
        asked += 1;
        return false;
      },
    };
    await mount(w, { now: T0 }, { keeps: [board, counting] }).tick(controller.signal);
    expect(asked).toBe(0);
    expect(w.storage.archivedCount()).toBe(0);
  });
});
