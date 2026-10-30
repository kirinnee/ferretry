import { afterEach, describe, it, spyOn } from 'bun:test';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { NodeCodexRolloutIndex } from '../../../../src/adapters/index.ts';

/**
 * What a rollout discovery COSTS, counted at the file system.
 *
 * An unresolved Codex session is discovered on every transcript read, so the walk's price is paid
 * every couple of seconds for as long as the session lives. These tests count the calls the index
 * makes against the real file system — white-box, through a spy that still calls through — rather
 * than its answers, which the other index tests own.
 */

const directories = new Set<string>();
const spies: Array<{ mockRestore(): void }> = [];

afterEach(async () => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  for (const directory of directories) await fs.rm(directory, { recursive: true, force: true });
  directories.clear();
});

async function temporaryHome(): Promise<string> {
  const directory = await fs.mkdtemp(join(tmpdir(), 'ferretry-codex-cost-'));
  directories.add(directory);
  return directory;
}

const uuid = (index: number): string => `${index.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`;

/** One rollout as Codex writes it: a `session_meta` header, then ordinary records. */
async function writeRollout(home: string, day: string, id: string, body: readonly string[] = []): Promise<string> {
  const directory = join(home, 'sessions', day);
  await fs.mkdir(directory, { recursive: true });
  const file = join(directory, `rollout-${day.replaceAll('/', '-')}-${id}.jsonl`);
  const lines = [JSON.stringify({ type: 'session_meta', payload: { id, cwd: '/work/repo' } }), ...body];
  await fs.writeFile(file, `${lines.join('\n')}\n`, 'utf8');
  return file;
}

/**
 * Dates every directory under `home/sessions` an hour back, so its listing counts as settled and a
 * later change is a modification time that visibly moved — never one that shares the tick.
 */
async function settle(home: string): Promise<void> {
  const past = Date.now() / 1_000 - 3_600;
  const pending = [join(home, 'sessions')];
  while (pending.length > 0) {
    const directory = pending.shift() as string;
    for (const entry of await fs.readdir(directory, { withFileTypes: true }))
      if (entry.isDirectory()) pending.push(join(directory, entry.name));
    await fs.utimes(directory, past, past);
  }
}

/**
 * Records, by path, every `stat`, `readdir` and `open` made from here on UNDER `home`.
 *
 * The spies see every call in the test process, so a stat by another file's leftover work (a watcher, a
 * timer still settling) used to land in the count ("expected 7 to be 5" on #1003). Only this test's own
 * home is the index's business; anything else is someone else's call.
 */
function countCalls(home: string) {
  const stat = spyOn(fs, 'stat');
  const readdir = spyOn(fs, 'readdir');
  const open = spyOn(fs, 'open');
  spies.push(stat, readdir, open);
  const paths = (spy: { mock: { calls: unknown[][] } }): string[] =>
    spy.mock.calls.map(call => String(call[0])).filter(path => path === home || path.startsWith(`${home}/`));
  return {
    stats: () => paths(stat),
    listings: () => paths(readdir),
    opens: () => paths(open),
    reset: () => {
      stat.mockClear();
      readdir.mockClear();
      open.mockClear();
    },
  };
}

const rolloutsIn = (paths: readonly string[]): string[] => paths.filter(path => path.endsWith('.jsonl'));

describe('NodeCodexRolloutIndex cost', () => {
  it('should never stat or read a rollout the caller excludes, across two thousand of them', async () => {
    // Arrange: an owner-sized home, its baseline recorded the way a start records it.
    const home = await temporaryHome();
    for (let index = 0; index < 2_000; index += 1)
      await writeRollout(home, `2026/10/${String((index % 28) + 1).padStart(2, '0')}`, uuid(index));
    await settle(home);
    const index = new NodeCodexRolloutIndex();
    const baseline = new Set(await index.ids(home));
    const token = '/state/sessions/20261020-mine';
    const mine = await writeRollout(home, '2026/10/28', uuid(9_999), [
      JSON.stringify({ type: 'response_item', payload: { text: `working in ${token}` } }),
    ]);
    const calls = countCalls(home);

    // Act: the reads an unresolved session makes while it waits.
    const answers = [];
    for (let read = 0; read < 10; read += 1) answers.push(await index.candidates(home, token, baseline));

    // Assert: only the one rollout outside the baseline is ever looked at, once per read.
    should(baseline.size).equal(2_000);
    for (const answer of answers) should(answer).eql([{ id: uuid(9_999), file: mine, correlated: true }]);
    should(rolloutsIn(calls.stats())).eql(Array.from({ length: 10 }, () => mine));
    should([...new Set(rolloutsIn(calls.opens()))]).eql([mine]);
  });

  it('should identify an unchanged rollout once, for the life of its path', async () => {
    // Arrange
    const home = await temporaryHome();
    const file = await writeRollout(home, '2026/10/20', uuid(1));
    const index = new NodeCodexRolloutIndex();
    await index.ids(home);
    const calls = countCalls(home);

    // Act
    const again = await index.ids(home);
    await index.candidates(home, '/state/sessions/other', new Set(again));

    // Assert: the header named the file, so neither a baseline nor an excluding walk reads it again.
    should(again).eql([uuid(1)]);
    should(rolloutsIn(calls.stats())).be.empty();
    should(calls.opens()).not.containEql(file);
  });

  it('should list a settled directory once, and again only when its entries change', async () => {
    // Arrange
    const home = await temporaryHome();
    await writeRollout(home, '2026/10/20', uuid(1));
    await writeRollout(home, '2026/10/21', uuid(2));
    await settle(home);
    const index = new NodeCodexRolloutIndex();
    const first = await index.ids(home);
    const changesAfterFirst = index.changes(home);
    const calls = countCalls(home);

    // Act + Assert: an untouched home is one `stat` per directory and no listing at all.
    should(await index.ids(home)).eql(first);
    should(calls.listings()).be.empty();
    should(calls.stats().length).equal(5);
    should(index.changes(home)).equal(changesAfterFirst);

    // A new rollout in an existing day is one listing of that day.
    calls.reset();
    await writeRollout(home, '2026/10/21', uuid(3));
    should([...(await index.ids(home))].sort()).eql([uuid(1), uuid(2), uuid(3)]);
    should(calls.listings()).eql([join(home, 'sessions/2026/10/21')]);
    should(index.changes(home)).equal(changesAfterFirst + 1);

    // A new day is a listing of its month and of the day itself.
    await settle(home);
    await index.ids(home);
    calls.reset();
    await writeRollout(home, '2026/10/22', uuid(4));
    should(await index.ids(home)).containEql(uuid(4));
    should(calls.listings()).eql([join(home, 'sessions/2026/10'), join(home, 'sessions/2026/10/22')]);
    should(index.changes(home)).equal(changesAfterFirst + 2);

    // A removed rollout is gone from the next walk.
    await settle(home);
    await index.ids(home);
    calls.reset();
    await fs.rm(join(home, 'sessions/2026/10/20', `rollout-2026-10-20-${uuid(1)}.jsonl`));
    should([...(await index.ids(home))].sort()).eql([uuid(2), uuid(3), uuid(4)]);
    should(calls.listings()).eql([join(home, 'sessions/2026/10/20')]);
    should(index.changes(home)).equal(changesAfterFirst + 3);

    // A removed day is gone too, with every rollout it held.
    await settle(home);
    await index.ids(home);
    await fs.rm(join(home, 'sessions/2026/10/22'), { recursive: true });
    should([...(await index.ids(home))].sort()).eql([uuid(2), uuid(3)]);
    should(index.changes(home)).equal(changesAfterFirst + 4);
  });

  it('should list again a directory that was just changed, however still its time looks', async () => {
    // Arrange: a directory's time has a granularity, so a listing taken in the same tick as a change
    // cannot prove the next change will move it. The index refuses to trust such a listing.
    const home = await temporaryHome();
    await writeRollout(home, '2026/10/20', uuid(1));
    const index = new NodeCodexRolloutIndex();
    await index.ids(home);
    const calls = countCalls(home);

    // Act
    await index.ids(home);

    // Assert: nothing here has settled, so every directory is listed again.
    should(calls.listings()).containEql(join(home, 'sessions/2026/10/20'));
  });

  it('should list again a directory it is told changed, even when its time was put back', async () => {
    // Arrange: the change a watcher would report, made invisible to the modification time.
    const home = await temporaryHome();
    await writeRollout(home, '2026/10/20', uuid(1));
    await settle(home);
    const index = new NodeCodexRolloutIndex();
    await index.ids(home);
    const day = join(home, 'sessions/2026/10/20');
    const { mtime } = await fs.stat(day);
    await writeRollout(home, '2026/10/20', uuid(2));
    await fs.utimes(day, mtime, mtime);
    const before = index.changes(home);

    // Act
    const hidden = await index.ids(home);
    index.invalidate(day);
    const told = index.changes(home);
    const seen = await index.ids(home);

    // Assert
    should(hidden).eql([uuid(1)]);
    should(told).equal(before + 1);
    should([...seen].sort()).eql([uuid(1), uuid(2)]);
  });

  it('should name a rollout by the id its first record carries when that record is not the session header', async () => {
    // Arrange: a rollout whose head opens with another record kind that still names the session.
    const home = await temporaryHome();
    const directory = join(home, 'sessions/2026/10/20');
    await fs.mkdir(directory, { recursive: true });
    const named = uuid(7);
    const file = join(directory, `rollout-2026-10-20-${uuid(8)}.jsonl`);
    await fs.writeFile(file, `${JSON.stringify({ type: 'turn_context', payload: { id: named } })}\n`, 'utf8');
    const index = new NodeCodexRolloutIndex();

    // Act
    const ids = await index.ids(home);

    // Assert: the record's id wins over the one the filename carries.
    should(ids).eql([named]);
  });

  it('should still report by its filename a rollout that vanished after its directory was listed', async () => {
    // Arrange: a settled listing that names a rollout, then the rollout removed with the directory's time put back.
    const home = await temporaryHome();
    const file = await writeRollout(home, '2026/10/20', uuid(1));
    await settle(home);
    const index = new NodeCodexRolloutIndex();
    await index.ids(home);
    const day = join(home, 'sessions/2026/10/20');
    const { mtime } = await fs.stat(day);
    await fs.rm(file);
    await fs.utimes(day, mtime, mtime);

    // Act
    const ids = await index.ids(home);
    const candidates = await index.candidates(home, '/state/sessions/any');

    // Assert: the cached listing still names it; it is reported by the uuid its filename carries, with nothing to read.
    should(ids).eql([uuid(1)]);
    should(candidates).eql([{ id: uuid(1), file, correlated: false }]);
  });

  it('should count no change for a directory it has never walked into', () => {
    // Arrange
    const index = new NodeCodexRolloutIndex();

    // Act
    index.invalidate('/nowhere/sessions/2026');

    // Assert
    should(index.changes('/nowhere')).equal(0);
  });

  it('should share one walk between callers that ask at once', async () => {
    // Arrange
    const home = await temporaryHome();
    await writeRollout(home, '2026/10/20', uuid(1));
    await settle(home);
    const index = new NodeCodexRolloutIndex();
    await index.ids(home);
    const calls = countCalls(home);

    // Act
    const answers = await Promise.all([index.ids(home), index.ids(home), index.ids(home)]);

    // Assert: one pass over the four directories, not three.
    for (const answer of answers) should(answer).eql([uuid(1)]);
    should(calls.stats().length).equal(4);
  });
});
