import { describe, expect, test } from 'bun:test';
import type { StatePort } from '@ferretry/kernel/contract';
import { MemoryStateFolder } from '@ferretry/kernel/testing';
import { ArchiveFile, type ArchiveKeepSource } from '../../../../contract/index.ts';
import { DaemonStorage } from '../../../../daemon/adapters/storage/session-storage.ts';
import {
  ARCHIVE_PASS_EVERY_MS,
  ARCHIVE_TICK_MS,
  archiveAfterMs,
  buildArchive,
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
  } = {},
) {
  return buildArchive({
    storage: w.storage,
    settings: () => ({ afterHours: more.afterHours ?? 24 }),
    nowMs: () => clock.now,
    pinned: async () => new Map(),
    keeps: () => more.keeps ?? [board, agenda],
    isLive: more.isLive ?? (() => false),
    loaded: async () => undefined,
    yieldToLoop: async () => undefined,
    directory: id => `sessions/${id}`,
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
      cards: async () => [{ owner: 'aa-1', assignee: null, dropped: false, category: 'review' }],
    };
    await mount(w, { now: T0 }, { keeps: [holding, agenda] }).tick();
    expect(w.storage.listArchivedSessions().map(row => String(row.id))).toEqual(['bb-1']);
  });

  test('a dropped card holds nobody, and a card of a closed lane holds nobody', async () => {
    const w = await world(['aa-1', 'bb-1']);
    const cards: ArchiveKeepSource = {
      kind: 'board',
      cards: async () => [
        { owner: 'aa-1', assignee: null, dropped: true, category: 'active' },
        { owner: 'bb-1', assignee: null, dropped: false, category: 'closed' },
      ],
    };
    await mount(w, { now: T0 }, { keeps: [cards, agenda] }).tick();
    expect(w.storage.listArchivedSessions().map(row => String(row.id))).toEqual(['aa-1', 'bb-1']);
  });
});
