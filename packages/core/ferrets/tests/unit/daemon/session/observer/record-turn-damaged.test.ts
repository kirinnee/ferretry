import { afterEach, describe, it } from 'bun:test';
import should from 'should';
import { FerretStateFile, type FerretId, type FerretRecord } from '../../../../../contract/index.ts';
import { FakeRunner, T0 as RECORD_T0 } from '../../../../../contract/testing/index.ts';
import { recordTurnChange } from '../../../../../daemon/adapters/session/observer/session-observation-applier.ts';
import { InvalidStateDocumentError } from '../../../../../daemon/adapters/storage/session-storage.ts';
import { buildTurnWatch } from '../../../../../daemon/modules/turn-watch.ts';
import { parseSessionId } from '../../../../../daemon/lib/session-id.ts';
import { memoryStorage, RecordingLog, sessionConfig } from '../../../../support/daemon/storage.ts';

const AT = '2026-11-08T10:00:00.000Z';
/** Words that must never reach a log: the damaged document's own text. */
const CONTENT = 'sk-damaged-document-content';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function opened() {
  const made = await memoryStorage({ clock: { now: () => AT } });
  cleanups.push(async () => await made.storage.close());
  return made;
}

/** A live session document whose turn is recorded `working`. */
async function working(storage: Awaited<ReturnType<typeof opened>>['storage'], raw: string) {
  const id = parseSessionId(raw);
  await storage.writeConfig(id, sessionConfig(id));
  await storage.writeState(id, { id, status: 'running', turn: 1, turnState: 'working', turnStateAt: AT });
  return id;
}

/**
 * A transcript whose newest record is the agent mid-turn: the pane's idle prompt then disagrees with it, so the end of a
 * turn needs its second look (the two-frame rule the transcript gives) — which is when these tests damage the document.
 */
const MID_TURN_TAIL = {
  tail: async () => ({
    kind: 'read' as const,
    events: [
      {
        kind: 'reasoning' as const,
        harness: 'claude' as const,
        role: 'assistant' as const,
        text: '',
        format: 'thinking' as const,
      },
    ],
  }),
};

describe('recordTurnChange over a damaged state.json (today’s rule, R/src/adapters/storage/session-storage.ts:1316)', () => {
  it('recordTurnChange throws naming state.json when it is not JSON', async () => {
    // Arrange
    const { storage, folder } = await opened();
    const id = await working(storage, 'damaged-1');
    const damaged = `{"status": "running", "note": "${CONTENT}"`;
    folder.plant(FerretStateFile, damaged, id);

    // Act
    const thrown = await recordTurnChange(storage, id, { from: 'working', to: 'your-turn' }, AT).then(
      () => undefined,
      (error: unknown) => error,
    );

    // Assert: it names the file, under the lock, and writes nothing over it.
    should(thrown).be.instanceOf(InvalidStateDocumentError);
    should((thrown as InvalidStateDocumentError).file).endWith('state.json');
    should(folder.raw(FerretStateFile, id)).equal(damaged);
  });

  it('recordTurnChange writes nothing for a schema-invalid document', async () => {
    // Arrange: a document the storage hands over as it is, which today's schema refuses.
    const id = parseSessionId('damaged-2');
    const invalid = { id, status: 'not-a-status', turn: 1, turnState: 'working' };
    const writes: unknown[] = [];
    const appended: string[] = [];
    const storage = {
      updateState: async (_id: unknown, transform: (current: never) => unknown) => {
        const next = transform(invalid as never);
        if (next !== invalid) writes.push(next);
        return next as never;
      },
      append: async (_id: unknown, type: string) => {
        appended.push(type);
        return undefined as never;
      },
    };

    // Act
    const written = await recordTurnChange(storage, id, { from: 'working', to: 'your-turn' }, AT);

    // Assert: left as it is, nothing written and nothing journaled.
    should(written).be.false();
    should(writes).deepEqual([]);
    should(appended).deepEqual([]);
  });

  it("recordTurnChange writes nothing for a schema-invalid document the store itself refuses (5.0: the declared schema is today's, strict)", async () => {
    // Arrange
    const { storage, folder } = await opened();
    const id = await working(storage, 'damaged-4');
    const invalid = JSON.stringify({ format: 1, id, status: 'not-a-status', turn: 1, turnState: 'working' });
    folder.plant(FerretStateFile, invalid, id);

    // Act
    const thrown = await recordTurnChange(storage, id, { from: 'working', to: 'your-turn' }, AT).then(
      () => undefined,
      (error: unknown) => error,
    );

    // Assert: the kernel's read refuses it under the lock, naming the file; the document is left as it is.
    should(thrown).be.instanceOf(InvalidStateDocumentError);
    should((thrown as InvalidStateDocumentError).file).endWith('state.json');
    should(folder.raw(FerretStateFile, id)).equal(invalid);
  });

  it('the inline host logs that throw (file named, no content) and keeps watching other ferrets', async () => {
    // Arrange: two live ferrets, both panes drawing (working, nothing to record) on the first look.
    const { storage, folder } = await opened();
    const broken = await working(storage, 'damaged-3');
    const healthy = await working(storage, 'healthy-3');
    const runner = new FakeRunner();
    const records = new Map<string, FerretRecord>(
      [broken, healthy].map(id => [
        id,
        {
          format: 1,
          id: id as unknown as FerretId,
          name: id,
          role: 'lead',
          harness: 'claude-code',
          runner: 'tmux',
          folder: `/work/${id}`,
          state: 'working',
          handle: runner.adoptable(id as unknown as FerretId),
          createdAt: RECORD_T0,
          stateAt: RECORD_T0,
        } as FerretRecord,
      ]),
    );
    const followed: string[] = [];
    const log = new RecordingLog();
    let nowMs = Date.parse(AT);
    const { host } = buildTurnWatch({
      storage,
      tail: MID_TURN_TAIL,
      record: ferret => records.get(ferret),
      runner: () => runner,
      turnObserved: async (ferret, turn) => void followed.push(`${ferret}:${turn}`),
      clock: { now: () => new Date(nowMs).toISOString() },
      every: () => () => undefined,
      yieldToLoop: async () => undefined,
      log,
    });
    for (const record of records.values())
      runner.screens.set(record.handle as never, { frame: 'w', working: true, atPrompt: false, permission: false });
    await host.turns.run();
    nowMs += 2_000;
    // Both turns end: each pane now shows only its idle prompt (seen once, then confirmed by the next look).
    runner.screens.clear();
    await host.turns.run();
    nowMs += 2_000;
    // The broken ferret's document is damaged behind the daemon's back, after the host learned its facts: a value the
    // parser's own account of it quotes (an enum error echoes what it received), so a log that carried the error text
    // would carry the content.
    folder.plant(
      FerretStateFile,
      JSON.stringify({ format: 1, id: broken, status: 'running', turn: 1, turnState: CONTENT }),
      broken,
    );

    // Act
    const report = await host.turns.run();

    // Assert: the throw is reported and logged by file only, and the other ferret's turn still ended.
    should([...(report?.failures.keys() ?? [])]).deepEqual([broken]);
    const warned = log.lines.filter(line => line.level === 'warn');
    should(warned).have.length(1);
    should(warned[0]?.fields?.ferret).equal(broken);
    should(String(warned[0]?.fields?.file)).endWith('state.json');
    // Exactly the ferret and the file: no error text, no name, nothing else a parser could have quoted.
    should(Object.keys(warned[0]?.fields ?? {}).sort()).deepEqual(['ferret', 'file']);
    should(JSON.stringify(log.lines)).not.containEql(CONTENT);
    should(followed).deepEqual([`${healthy}:your-turn`]);
    should(await storage.readState(healthy)).have.property('turnState', 'your-turn');
  });

  it('one damaged state.json among 30 does not stop the watch for the other 29, and is said ONCE until its damage changes', async () => {
    // Arrange: thirty live ferrets mid-turn, every pane drawing (a turn in progress, nothing to record).
    const { storage, folder } = await opened();
    const ids = [];
    for (let n = 0; n < 30; n += 1) ids.push(await working(storage, `fleet-${n}`));
    const broken = ids[7] as (typeof ids)[number];
    const runner = new FakeRunner();
    const records = new Map<string, FerretRecord>(
      ids.map(id => [
        id,
        {
          format: 1,
          id: id as unknown as FerretId,
          name: id,
          role: 'lead',
          harness: 'claude-code',
          runner: 'tmux',
          folder: `/work/${id}`,
          state: 'working',
          handle: runner.adoptable(id as unknown as FerretId),
          createdAt: RECORD_T0,
          stateAt: RECORD_T0,
        } as FerretRecord,
      ]),
    );
    const followed: string[] = [];
    const log = new RecordingLog();
    let nowMs = Date.parse(AT);
    const { host } = buildTurnWatch({
      storage,
      tail: MID_TURN_TAIL,
      record: ferret => records.get(ferret),
      runner: () => runner,
      turnObserved: async (ferret, turn) => void followed.push(`${ferret}:${turn}`),
      clock: { now: () => new Date(nowMs).toISOString() },
      every: () => () => undefined,
      yieldToLoop: async () => undefined,
      log,
    });
    for (const record of records.values())
      runner.screens.set(record.handle as never, { frame: 'w', working: true, atPrompt: false, permission: false });
    await host.turns.run();
    // One document is damaged behind the daemon's back (a value the parser's account quotes), then every turn ends.
    folder.plant(
      FerretStateFile,
      JSON.stringify({ format: 1, id: broken, status: 'running', turn: 1, turnState: CONTENT }),
      broken,
    );
    runner.screens.clear();
    const warnings = () => log.lines.filter(line => line.level === 'warn');
    const ticks = async (count: number) => {
      for (let tick = 0; tick < count; tick += 1) {
        nowMs += 2_000;
        await host.turns.run();
      }
    };

    // Act: the two looks that end a turn (the idle prompt seen, then confirmed).
    await ticks(2);

    // Assert: the other 29 turns all ended on that same tick, the damaged one in the middle of them notwithstanding.
    const healthy = ids.filter(id => id !== broken);
    should([...followed].sort()).deepEqual(healthy.map(id => `${id}:your-turn`).sort());
    for (const id of healthy) should(await storage.readState(id)).have.property('turnState', 'your-turn');

    // Act + Assert: the rest of a minute of 2 s ticks: the damaged one is said once, by file only.
    await ticks(28);
    should(followed).have.length(29);
    should(warnings()).have.length(1);
    should(warnings()[0]?.fields).deepEqual({ ferret: broken, file: warnings()[0]?.fields?.file });
    should(String(warnings()[0]?.fields?.file)).endWith('state.json');

    // Act + Assert: its damage changes (no longer JSON at all): said once more, and not again.
    folder.plant(FerretStateFile, '{"turnState": "', broken);
    await ticks(30);
    should(warnings()).have.length(2);
    should(warnings()[1]?.fields?.ferret).equal(broken);
    should(JSON.stringify(log.lines)).not.containEql(CONTENT);
    should(folder.raw(FerretStateFile, broken)).equal('{"turnState": "');
  });
});
