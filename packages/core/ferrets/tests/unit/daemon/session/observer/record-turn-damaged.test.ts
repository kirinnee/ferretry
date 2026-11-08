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

  it('the inline host backs a damaged ferret off for real: one warning per 10 s, not one per 2 s tick', async () => {
    // Arrange: one live ferret whose pane shows its idle prompt, so its turn must end, but its document is damaged.
    const { storage, folder } = await opened();
    const broken = await working(storage, 'damaged-5');
    const runner = new FakeRunner();
    const record = {
      format: 1,
      id: broken as unknown as FerretId,
      name: broken,
      role: 'lead',
      harness: 'claude-code',
      runner: 'tmux',
      folder: '/work/damaged-5',
      state: 'working',
      handle: runner.adoptable(broken as unknown as FerretId),
      createdAt: RECORD_T0,
      stateAt: RECORD_T0,
    } as FerretRecord;
    const log = new RecordingLog();
    let nowMs = Date.parse(AT);
    const { host } = buildTurnWatch({
      storage,
      record: () => record,
      runner: () => runner,
      turnObserved: async () => undefined,
      clock: { now: () => new Date(nowMs).toISOString() },
      every: () => () => undefined,
      yieldToLoop: async () => undefined,
      log,
    });
    // The turn ends on the second idle look; the document is damaged before that second look records it.
    await host.turns.run();
    folder.plant(FerretStateFile, '{"turnState": "', broken);
    const warnings = () => log.lines.filter(line => line.level === 'warn').length;

    // Act: a tick every 2 s for 20 s.
    const seen: number[] = [];
    for (let tick = 0; tick < 10; tick += 1) {
      nowMs += 2_000;
      await host.turns.run();
      seen.push(warnings());
    }

    // Assert: reported at the first failure, then once each 10 s, never on every tick.
    should(seen.at(-1)).be.belowOrEqual(3);
    should(seen.at(-1)).be.aboveOrEqual(2);
    should(seen[1]).equal(seen[0]);
    should(seen[2]).equal(seen[0]);
  });
});
