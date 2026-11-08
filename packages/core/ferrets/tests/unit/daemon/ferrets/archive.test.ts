import { describe, expect, test } from 'bun:test';
import {
  ArchiveFile,
  FerretConfigFile,
  type FerretId,
  FerretStateFile,
  type FerretSummary,
} from '../../../../contract/index.ts';
import {
  archiveWorld,
  archived,
  finishFerret,
  HOUR_MS,
  pass,
  settle,
  startFerret,
  tickArchive,
} from '../../../support/daemon/archive-world.ts';

/**
 * The session archive mounted in Ferrets (U6, docs/session-archive.md). Archiving hides sessions, so what these prove is
 * mostly what it must NOT do: archive without an answer from Board and Agenda, archive what a person drives, what still
 * runs or what something keeps, lose a document, or bring one back on a read.
 */

const archivedIds = async (h: Parameters<typeof archived>[0]): Promise<string[]> =>
  (await archived(h)).sessions.map(view => view.config.id).sort();

describe('the session archive: what it archives', () => {
  test('R-0047 GET /v1/archived-sessions answers how many and the newest first, and asking for none costs only the count', async () => {
    const { h } = await archiveWorld({ afterHours: 24 });
    const older = await startFerret(h, 'aniya');
    await finishFerret(h, older);
    await pass(h, 2 * HOUR_MS);
    const newer = await startFerret(h, 'bodhi');
    await finishFerret(h, newer);
    await pass(h, 25 * HOUR_MS);
    await tickArchive(h);

    const all = await archived(h);
    expect(all.count).toBe(2);
    // Newest first, by the instant each last changed.
    expect(all.sessions.map(view => view.config.id)).toEqual([newer, older]);
    expect((await archived(h, 1)).sessions.map(view => view.config.id)).toEqual([newer]);
    expect(await archived(h, 0)).toEqual({ count: 2, sessions: [] });
    expect((await h.request('GET', '/v1/archived-sessions', { query: { limit: '501' } })).status).toBe(400);
    await h.stop();
  });

  test('an autonomous ferret that ended a day ago leaves the live set once Board and Agenda have both answered', async () => {
    const { h, board, agenda } = await archiveWorld({ afterHours: 24 });
    const id = await startFerret(h, 'aniya');
    await finishFerret(h, id);
    await pass(h, 25 * HOUR_MS);
    await tickArchive(h);
    expect(await archivedIds(h)).toEqual([id]);
    expect(board.asked).toBeGreaterThan(0);
    expect([...new Set(agenda.asked)]).toEqual([id]);
    await h.stop();
  });

  test('a ferret that ended less than the age ago stays live', async () => {
    const { h } = await archiveWorld({ afterHours: 24 });
    const id = await startFerret(h, 'aniya');
    await finishFerret(h, id);
    await pass(h, 23 * HOUR_MS);
    await tickArchive(h);
    expect(await archivedIds(h)).toEqual([]);
    expect(id).toBeDefined();
    await h.stop();
  });
});

describe('the session archive: it is off until the owner says how old', () => {
  test.each([
    ['no archive.yaml', undefined],
    ['afterHours: off', 'off' as const],
  ])('%s: nothing more is archived, however old', async (_name, afterHours) => {
    const { h } = await archiveWorld(afterHours === undefined ? {} : { afterHours });
    const id = await startFerret(h, 'aniya');
    await finishFerret(h, id);
    await pass(h, 400 * HOUR_MS);
    await tickArchive(h);
    expect(await archivedIds(h)).toEqual([]);
    // It is still there, live.
    expect((await h.request('GET', `/v1/ferrets/${id}`)).status).toBe(200);
    await h.stop();
  });
});

describe('the session archive: an absent answer is "keep live"', () => {
  test.each([
    ['Board has not contributed', { noBoard: true }],
    ['Agenda has not contributed', { noAgenda: true }],
    ['neither has', { noBoard: true, noAgenda: true }],
  ])('%s: no pass runs, and nothing is archived', async (_name, absent) => {
    const { h, agenda } = await archiveWorld({ afterHours: 24, ...absent });
    const id = await startFerret(h, 'aniya');
    await finishFerret(h, id);
    await pass(h, 100 * HOUR_MS);
    await tickArchive(h);
    expect(await archivedIds(h)).toEqual([]);
    // Not even a read of the half that is there: the pass did not start.
    expect(agenda.asked).toEqual([]);
    expect(id).toBeDefined();
    await h.stop();
  });

  test('Board throws: every ferret stays live; and once it answers, the next pass archives', async () => {
    const { h, board } = await archiveWorld({ afterHours: 24 });
    const id = await startFerret(h, 'aniya');
    await finishFerret(h, id);
    await pass(h, 25 * HOUR_MS);
    board.broken = true;
    await tickArchive(h);
    expect(await archivedIds(h)).toEqual([]);
    board.broken = false;
    // The pass that kept everything is not tried again for an hour; then it is.
    await pass(h, 2 * HOUR_MS);
    await tickArchive(h);
    expect(await archivedIds(h)).toEqual([id]);
    await h.stop();
  });

  test('Agenda throws: that ferret stays live', async () => {
    const { h, agenda } = await archiveWorld({ afterHours: 24 });
    const id = await startFerret(h, 'aniya');
    await finishFerret(h, id);
    await pass(h, 25 * HOUR_MS);
    agenda.broken = true;
    await tickArchive(h);
    expect(await archivedIds(h)).toEqual([]);
    expect([...new Set(agenda.asked)]).toEqual([id]);
    await h.stop();
  });
});

describe('the session archive: what keeps a finished ferret live', () => {
  async function aged() {
    const world = await archiveWorld({ afterHours: 24 });
    const id = await startFerret(world.h, 'aniya');
    await finishFerret(world.h, id);
    await pass(world.h, 25 * HOUR_MS);
    return { ...world, id };
  }

  test('a card still in flight keeps it, and a card that is closed does not', async () => {
    const { h, board, id } = await aged();
    board.cards = [{ owner: id, assignee: null, dropped: false, category: 'active' }];
    await tickArchive(h);
    expect(await archivedIds(h)).toEqual([]);
    board.cards = [{ owner: id, assignee: null, dropped: false, category: 'closed' }];
    await pass(h, 2 * HOUR_MS);
    await tickArchive(h);
    expect(await archivedIds(h)).toEqual([id]);
    await h.stop();
  });

  test('a card whose lane Board could not name reads as in flight', async () => {
    const { h, board, id } = await aged();
    board.cards = [{ owner: 'someone-else', assignee: id, dropped: false, category: undefined }];
    await tickArchive(h);
    expect(await archivedIds(h)).toEqual([]);
    board.cards = [{ owner: 'someone-else', assignee: id, dropped: false, category: 'no-such-lane' }];
    await pass(h, 2 * HOUR_MS);
    await tickArchive(h);
    expect(await archivedIds(h)).toEqual([]);
    await h.stop();
  });

  test('an open agenda item keeps it', async () => {
    const { h, agenda, id } = await aged();
    agenda.open.add(id);
    await tickArchive(h);
    expect(await archivedIds(h)).toEqual([]);
    await h.stop();
  });

  test('a ferret the owner pinned stays live', async () => {
    const { h, id } = await aged();
    expect((await h.request('POST', `/v1/ferrets/${id}/pin`, { body: {} })).status).toBeLessThan(300);
    await tickArchive(h);
    expect(await archivedIds(h)).toEqual([]);
    await h.stop();
  });

  test('a ferret a person drives is never archived, however old', async () => {
    const { h } = await archiveWorld({ afterHours: 24 });
    const id = await startFerret(h, 'aniya', { mode: 'interactive' });
    await finishFerret(h, id);
    await pass(h, 1_000 * HOUR_MS);
    await tickArchive(h);
    expect(await archivedIds(h)).toEqual([]);
    await h.stop();
  });

  test('a ferret that is still running is never archived', async () => {
    const { h } = await archiveWorld({ afterHours: 24 });
    const id = await startFerret(h, 'aniya');
    await pass(h, 1_000 * HOUR_MS);
    await tickArchive(h);
    expect(await archivedIds(h)).toEqual([]);
    expect((await h.request('GET', `/v1/ferrets/${id}`)).json<FerretSummary>().state).not.toBe('stopped');
    await h.stop();
  });
});

describe('the session archive: nothing is lost, and only a write brings a session back', () => {
  test('archiving moves nothing: the documents are the same bytes, and the ferret still answers', async () => {
    const { h } = await archiveWorld({ afterHours: 24 });
    const id = await startFerret(h, 'aniya');
    await finishFerret(h, id);
    await pass(h, 25 * HOUR_MS);
    const before = {
      config: h.state('ferrets').raw(FerretConfigFile, id),
      state: h.state('ferrets').raw(FerretStateFile, id),
    };
    expect(before.config).toBeDefined();
    await tickArchive(h);
    expect(await archivedIds(h)).toEqual([id]);
    expect({
      config: h.state('ferrets').raw(FerretConfigFile, id),
      state: h.state('ferrets').raw(FerretStateFile, id),
    }).toEqual(before);
    expect((await h.request('GET', `/v1/ferrets/${id}`)).status).toBe(200);
    await h.stop();
  });

  test('reading an archived ferret, or the archive list, never brings it back', async () => {
    const { h } = await archiveWorld({ afterHours: 24 });
    const id = await startFerret(h, 'aniya');
    await finishFerret(h, id);
    await pass(h, 25 * HOUR_MS);
    await tickArchive(h);
    for (let read = 0; read < 3; read += 1) {
      expect((await h.request('GET', `/v1/ferrets/${id}`)).status).toBe(200);
      expect(await archivedIds(h)).toEqual([id]);
    }
    const registry = h.state('ferrets').raw(FerretStateFile, id);
    expect((await h.request('GET', '/v1/ferrets')).status).toBe(200);
    expect(h.state('ferrets').raw(FerretStateFile, id)).toBe(registry);
    expect(await archivedIds(h)).toEqual([id]);
    await h.stop();
  });

  test('a write brings it back: resuming an archived ferret makes it live again, and it is not archived twice', async () => {
    const { h } = await archiveWorld({ afterHours: 24 });
    const id = await startFerret(h, 'aniya');
    await finishFerret(h, id);
    await pass(h, 25 * HOUR_MS);
    await tickArchive(h);
    expect(await archivedIds(h)).toEqual([id]);
    const resumed = await h.request('POST', `/v1/ferrets/${id}/resume`, { body: {} });
    expect(resumed.status).toBeLessThan(300);
    await settle(h);
    expect(await archivedIds(h)).toEqual([]);
    expect(JSON.parse(h.state('ferrets').files.get('archive.json') as string).sessions).toEqual({});
    await h.stop();
  });

  test('a crash right after the registry write leaves the session archived and readable, never half moved, and the next pass does not archive it twice', async () => {
    const { h } = await archiveWorld({ afterHours: 24 });
    const id = await startFerret(h, 'aniya');
    await finishFerret(h, id);
    await pass(h, 25 * HOUR_MS);
    const before = {
      config: h.state('ferrets').raw(FerretConfigFile, id),
      state: h.state('ferrets').raw(FerretStateFile, id),
    };
    h.crashAfterNextWrite();
    await tickArchive(h).catch(() => undefined);
    const again = await h.restart();
    // The registry is the first thing a pass writes, and it landed: the ferret is archived, answers, and lost nothing.
    expect((await again.request('GET', `/v1/ferrets/${id}`)).status).toBe(200);
    expect({
      config: again.state('ferrets').raw(FerretConfigFile, id),
      state: again.state('ferrets').raw(FerretStateFile, id),
    }).toEqual(before);
    expect(await archivedIds(again)).toEqual([id]);
    // A pass after the restart finds it archived already: once, never twice.
    await pass(again, 2 * HOUR_MS);
    await tickArchive(again);
    expect(await archivedIds(again)).toEqual([id]);
    await again.stop();
  });
});

describe('the session archive: a lead outlives its helpers', () => {
  test('a lead with a helper still running is kept, and the pass archives both once the helper has ended', async () => {
    const { h } = await archiveWorld({ afterHours: 24, packs: true });
    const lead = await startFerret(h, 'aniya');
    const helperStart = await h.request('POST', '/v1/ferrets', {
      body: { name: 'bodhi', folder: '/work/bodhi', parent: lead },
      headers: { 'x-fy-request-id': 'helper-1' },
    });
    expect(helperStart.status).toBeLessThan(300);
    const helper = helperStart.json<{ id: FerretId }>().id;
    await finishFerret(h, lead);
    await pass(h, 25 * HOUR_MS);
    await tickArchive(h);
    expect(await archivedIds(h)).toEqual([]);
    await finishFerret(h, helper);
    await pass(h, 25 * HOUR_MS);
    await tickArchive(h);
    expect(await archivedIds(h)).toEqual([helper, lead].sort());
    await h.stop();
  });
});

describe('archived callsigns (U6): a name an archived session answers to is not handed out for five days', () => {
  const planted = (name: string, createdAt: string, updatedAt: string) =>
    JSON.stringify({
      format: 1,
      sessions: {
        'mw0000aa-00000001': {
          archivedAt: createdAt,
          name,
          configCreatedAt: createdAt,
          configUpdatedAt: updatedAt,
          status: 'stopped',
          lastSequence: 1,
          journalLine: 2,
          journal: null,
        },
      },
    });

  test('archive keeps archived callsigns held for the window', async () => {
    const { h } = await archiveWorld();
    h.state('ferrets').plant(ArchiveFile, planted('wren', h.clock.now(), h.clock.now()));
    const again = await h.restart();
    const start = async (name: string) =>
      await again.request('POST', '/v1/ferrets', {
        body: { name, folder: `/work/${name}` },
        headers: { 'x-fy-request-id': `start-${name}-${String(again.clock.nowMs())}` },
      });
    // Held while the window runs: the archived session left the live list, not its callsign.
    const taken = await start('wren');
    expect(taken.status).toBe(409);
    expect(taken.body).toContain('wren');
    // The suggestions do not offer it either.
    const names = (await again.request('GET', '/v1/names', { query: { count: '200' } })).json<string[]>();
    expect(names).not.toContain('wren');
    // The window ends, and the name is free again.
    await pass(again, 5 * 24 * HOUR_MS + HOUR_MS);
    expect((await start('wren')).status).toBe(201);
    await again.stop();
  });
});

describe('the end of a ferret is stamped on its state document, and a start again drops it', () => {
  test('a stop writes finishedAt (what the archive measures its age from) and a resume removes it', async () => {
    const { h } = await archiveWorld();
    const id = await startFerret(h, 'aniya');
    const document = () => JSON.parse(h.state('ferrets').raw(FerretStateFile, id) as string) as Record<string, unknown>;
    expect(document().finishedAt).toBeUndefined();
    await finishFerret(h, id);
    expect(document().status).toBe('stopped');
    expect(document().finishedAt).toBe(h.clock.now());
    await pass(h, 60_000);
    expect((await h.request('POST', `/v1/ferrets/${id}/resume`, { body: {} })).status).toBeLessThan(300);
    await settle(h);
    expect(document().status).toBe('running');
    expect(document().finishedAt).toBeUndefined();
    await h.stop();
  });
});

describe('the archive across a daemon restart', () => {
  test('a ferret that finished before the daemon restarted is archived by a pass after it', async () => {
    const { h } = await archiveWorld({ afterHours: 24 });
    const id = await startFerret(h, 'aniya');
    await finishFerret(h, id);
    const again = await h.restart();
    await pass(again, 25 * HOUR_MS);
    await tickArchive(again);
    expect(await archivedIds(again)).toEqual([id]);
    await again.stop();
  });
});
