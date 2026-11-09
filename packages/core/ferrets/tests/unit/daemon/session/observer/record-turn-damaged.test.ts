import { afterEach, describe, it } from 'bun:test';
import should from 'should';
import { FerretStateFile, type FerretId, type FerretRecord } from '../../../../../contract/index.ts';
import { FakeRunner, T0 as RECORD_T0 } from '../../../../../contract/testing/index.ts';
import { recordTurnChange } from '../../../../../daemon/adapters/session/observer/session-observation-applier.ts';
import { InvalidStateDocumentError } from '../../../../../daemon/adapters/storage/session-storage.ts';
import {
  buildTurnWatch,
  turnWatchFailureKey,
  turnWatchFailureSentence,
} from '../../../../../daemon/modules/turn-watch.ts';
import { parseSessionId } from '../../../../../daemon/lib/session-id.ts';
import {
  memoryStorage,
  realPortStorage,
  RecordingLog,
  sessionConfig,
  type RealPortStorage,
} from '../../../../support/daemon/storage.ts';

const AT = '2026-11-08T10:00:00.000Z';
/** Words that must never reach a log: the damaged document's own text. */
const CONTENT = 'sk-damaged-document-content';
/**
 * A FAKE secret written as a bare word into a corrupt file. The REAL state port's parser quotes what it chokes on
 * (`JSON Parse error: Unexpected identifier "FAKEsecretXYZ"`), so it reaches the refusal's `reason`; a log that echoed
 * that account would carry it. (The in-memory fake port never quotes a file, which is why these tests do not use it.)
 */
const SECRET = 'FAKEsecretXYZ';
/** The corrupt file's bytes: not JSON, and the bare word is what the real parser names in its account of it. */
const quoting = (suffix = ''): string => `{"format": 1, "turnState": ${SECRET}${suffix}}`;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function opened() {
  const made = await memoryStorage({ clock: { now: () => AT } });
  cleanups.push(async () => await made.storage.close());
  return made;
}

/** The same over the kernel's real state port (see `realPortStorage`): its refusals quote the file. */
async function openedReal(): Promise<RealPortStorage> {
  const made = await realPortStorage({ now: () => AT });
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

  it('BG-037 the inline host logs that throw (ferret, file and why named, no content) and keeps watching other ferrets', async () => {
    // Arrange: two live ferrets, both panes drawing (working, nothing to record) on the first look. The state port is
    // the REAL one, so the refusal's reason is the parser's own account of the corrupt file, quoting it.
    const { storage, plant } = await openedReal();
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
    // The broken ferret's document is damaged behind the daemon's back, after the host learned its facts.
    plant(broken, quoting());
    // The test can see what a leak would carry: the port's own refusal quotes the secret in its reason.
    const refusal = await storage.readState(broken).then(
      () => undefined,
      (error: unknown) => error,
    );
    should(refusal).be.instanceOf(InvalidStateDocumentError);
    should((refusal as InvalidStateDocumentError).reason).containEql(SECRET);

    // Act
    const report = await host.turns.run();

    // Assert: the throw is reported and logged by file only, and the other ferret's turn still ended.
    should([...(report?.failures.keys() ?? [])]).deepEqual([broken]);
    const warned = log.lines.filter(line => line.level === 'warn');
    should(warned).have.length(1);
    should(warned[0]?.fields?.ferret).equal(broken);
    should(String(warned[0]?.fields?.file)).endWith('state.json');
    // The ferret, the file and the KIND of damage (a fixed word): no error text, nothing a parser could have quoted.
    should(Object.keys(warned[0]?.fields ?? {}).sort()).deepEqual(['ferret', 'file', 'why']);
    should(warned[0]?.fields?.why).equal('unparsable');
    should(warned[0]?.message).containEql(broken);
    should(warned[0]?.message).containEql('not JSON');
    should(JSON.stringify(log.lines)).not.containEql(SECRET);
    should(followed).deepEqual([`${healthy}:your-turn`]);
    should(await storage.readState(healthy)).have.property('turnState', 'your-turn');
  });

  it('BG-037 one damaged state.json among 30 does not stop the watch for the other 29, and is said ONCE until its bytes change', async () => {
    // Arrange: thirty live ferrets mid-turn, every pane drawing (a turn in progress, nothing to record). The state port
    // is the REAL one, so a corrupt file's refusal quotes it, as in production.
    const { storage, plant, raw } = await openedReal();
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
    // One document is damaged behind the daemon's back (valid JSON that fails its schema), then every turn ends.
    plant(broken, JSON.stringify({ format: 1, id: broken, status: 'running', turn: 1, turnState: CONTENT }));
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
    should(warnings()[0]?.fields).deepEqual({ ferret: broken, file: warnings()[0]?.fields?.file, why: 'schema' });
    should(String(warnings()[0]?.fields?.file)).endWith('state.json');

    // Act + Assert: its damage changes (no longer JSON at all, and the parser's account of it quotes a FAKE secret):
    // said once more, and not again.
    plant(broken, quoting());
    const refusal = await storage.readState(broken).then(
      () => undefined,
      (error: unknown) => error,
    );
    should((refusal as InvalidStateDocumentError).reason).containEql(SECRET);
    await ticks(30);
    should(warnings()).have.length(2);
    should(warnings()[1]?.fields?.ferret).equal(broken);
    should(warnings()[1]?.fields?.why).equal('unparsable');
    should(JSON.stringify(log.lines)).not.containEql(SECRET);
    should(JSON.stringify(log.lines)).not.containEql(CONTENT);
    should(await raw(broken)).equal(quoting());

    // Act + Assert: a rewrite is a new report (the key is the file as last written, the port's version etag, not the
    // kind of damage), and the secret is still in no sentence, field or log line.
    plant(broken, quoting('2'));
    await ticks(30);
    should(warnings()).have.length(3);
    should(warnings()[2]?.fields?.why).equal('unparsable');
    should(JSON.stringify(log.lines)).not.containEql(SECRET);
    should(JSON.stringify(log.lines)).not.containEql('turnState');
  });

  it('BG-037 neither the sentence nor the dedupe key carries what the parser quoted', () => {
    // Arrange: the refusal the real port raises for a corrupt file, with and without a version etag.
    const reason = `state.json cannot be used: JSON Parse error: Unexpected identifier "${SECRET}"`;
    const withEtag = new InvalidStateDocumentError('/state/ferrets/x/state.json', reason, 'unparsable', '7:42:1000');
    const withoutEtag = new InvalidStateDocumentError('/state/ferrets/x/state.json', reason, 'unparsable');

    // Act
    const sentences = [turnWatchFailureSentence('x', withEtag), turnWatchFailureSentence('x', withoutEtag)];
    const keys = [turnWatchFailureKey(withEtag), turnWatchFailureKey(withoutEtag)];

    // Assert: a fixed vocabulary in the sentence; only a digest in the key (it falls back to the account when no etag).
    for (const text of [...sentences, ...keys]) should(String(text)).not.containEql(SECRET);
    should(keys[0]).not.equal(keys[1]);
  });

  it('BG-037 a mended state.json clears the report, so the same damage later is said again', async () => {
    // Arrange: one live ferret mid-turn whose document is damaged, and whose pane shows the turn over.
    const { storage, folder } = await opened();
    const id = await working(storage, 'mended-1');
    const runner = new FakeRunner();
    const record = {
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
    } as FerretRecord;
    const log = new RecordingLog();
    let nowMs = Date.parse(AT);
    const { host } = buildTurnWatch({
      storage,
      tail: MID_TURN_TAIL,
      record: ferret => (ferret === (id as unknown as FerretId) ? record : undefined),
      runner: () => runner,
      turnObserved: async () => undefined,
      clock: { now: () => new Date(nowMs).toISOString() },
      every: () => () => undefined,
      yieldToLoop: async () => undefined,
      log,
    });
    const warnings = () => log.lines.filter(line => line.level === 'warn');
    const ticks = async (count: number) => {
      for (let tick = 0; tick < count; tick += 1) {
        nowMs += 2_000;
        await host.turns.run();
      }
    };
    runner.screens.set(record.handle as never, { frame: 'w', working: true, atPrompt: false, permission: false });
    await host.turns.run();
    const damaged = '{"turnState": "';
    folder.plant(FerretStateFile, damaged, id);
    runner.screens.clear();
    await ticks(30);
    should(warnings()).have.length(1);

    // Act: the file is mended (a valid document), the turn ends and is written; then the SAME bytes break it again.
    folder.plant(
      FerretStateFile,
      JSON.stringify({ format: 1, id, status: 'running', turn: 1, turnState: 'working' }),
      id,
    );
    await ticks(30);
    should(await storage.readState(id)).have.property('turnState', 'your-turn');
    // A second turn is recorded (a send), its first end-look passes, and then the document breaks with the same bytes.
    await storage.writeState(id, { id, status: 'running', turn: 2, turnState: 'working', turnStateAt: AT });
    folder.plant(FerretStateFile, damaged, id);
    await ticks(30);

    // Assert: said again, once.
    should(warnings()).have.length(2);
  });
});
