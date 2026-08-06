import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { appendHandoverEventOnce } from '../../../bin/fyd.ts';
import {
  BunSqliteIndexFactory,
  DaemonStorageFactory,
  KeyedSerialExecutor,
  RuntimeEnvironment,
  SqliteHomeLockFactory,
  StateFileSystemFactory,
  StateHomeLayout,
  SystemClock,
} from '../../../src/adapters/index.ts';
import { parseSessionId } from '../../../src/lib/index.ts';

/**
 * The handover's completion journal, written at most once per side.
 *
 * WHY THIS TIER AND NOT A UNIT TEST. The contract is about what survives a crash, and the thing that
 * has to survive it is a FILE. Completion appends to two journals in a fixed order — the predecessor's,
 * then the replacement's — and a crash between them replays the whole step. A guard held in the process
 * would be empty again after exactly the event it exists to catch (the restart), so the deduplication
 * has to be read back from the same durable document it is written to, and only a real storage over a
 * real directory proves that it is.
 *
 * The failure this prevents is not cosmetic: a doubled `session.handover_completed` makes the fleet's
 * own history claim one session was handed over twice, and the journal is the evidence a human reads
 * when they ask what happened to a session that no longer exists.
 */

const NOW = '2026-02-01T00:00:00.000Z';
const SOURCE = parseSessionId('source-1');
const REPLACEMENT = parseSessionId('replacement-1');
const COMPLETED = 'session.handover_completed';

const homes = new Set<string>();

/**
 * The composition root's own per-session queue for this journal.
 *
 * One instance for the whole file, exactly as `bin/fyd.ts` holds one for the life of the daemon: a
 * serializer constructed per call would serialize nothing, which is the failure the concurrency case
 * below exists to catch.
 */
const serial = new KeyedSerialExecutor();

async function openStorage() {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-handover-journal-'));
  homes.add(home);
  const factory = new DaemonStorageFactory(
    new RuntimeEnvironment({ FY_HOME: home }, () => '/home-must-not-be-used'),
    new StateFileSystemFactory(),
    new StateHomeLayout(),
    new SqliteHomeLockFactory(),
    new BunSqliteIndexFactory(),
    new SystemClock(() => new Date(NOW)),
    () => new KeyedSerialExecutor(),
  );
  return await factory.open();
}

function config(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: 'A handover subject',
    agent: '/opt/fleet/bin/claude-auto-loge',
    command: ['/opt/fleet/bin/claude-auto-loge'],
    cwd: '/workspace/project',
    mode: 'auto',
    turn: 1,
    tmuxSession: `fy-${id}`,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/**
 * Every completion event this session's journal holds, read to the TRUE END.
 *
 * Paged rather than read as one bounded prefix for the same reason the production search is: a single
 * `replay(id, 0, limit)` answers about the oldest events, so on a long journal an assertion built on it
 * would report zero completions whether or not the code under test wrote two.
 */
/**
 * The operation id one journalled event carries, read without an unsafe chain.
 *
 * The event is taken as possibly-absent and its `data` is narrowed before anything is read off it, so a
 * missing row produces `undefined` — a clean "expected undefined to equal …" — instead of a TypeError
 * from dereferencing a short-circuited optional chain. A crash there would report a missing event as a
 * broken test rather than as the failed expectation it actually is.
 */
function operationIdOf(event: { readonly data: unknown } | undefined): unknown {
  const data = event?.data;
  return typeof data === 'object' && data !== null ? (data as Record<string, unknown>).operationId : undefined;
}

async function completions(
  storage: Awaited<ReturnType<typeof openStorage>>['storage'],
  id: ReturnType<typeof parseSessionId>,
): Promise<readonly { readonly type: string; readonly data: unknown }[]> {
  const found: { readonly type: string; readonly data: unknown }[] = [];
  let after = 0;
  for (;;) {
    const page = await storage.replay(id, after, 1_000);
    found.push(...page.events.filter(event => event.type === COMPLETED));
    if (!page.hasMore || page.nextSequence === undefined) return found;
    after = page.nextSequence;
  }
}

afterEach(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
  homes.clear();
});

describe('the handover completion journal', () => {
  it('should write one event per side, in source-then-replacement order, when a crash replays the step', async () => {
    // Arrange: two real sessions in a real state home, and the two operation ids one completion uses.
    const opened = await openStorage();
    await opened.storage.writeConfig(SOURCE, config('source-1'));
    await opened.storage.writeState(SOURCE, { id: 'source-1', status: 'running' });
    await opened.storage.writeConfig(REPLACEMENT, config('replacement-1'));
    await opened.storage.writeState(REPLACEMENT, { id: 'replacement-1', status: 'running' });
    const sourceAppend = {
      sessionId: 'source-1',
      operationId: 'handover-op:source',
      type: COMPLETED,
      data: { replacementSessionId: 'replacement-1' },
    };
    const replacementAppend = {
      sessionId: 'replacement-1',
      operationId: 'handover-op:replacement',
      type: COMPLETED,
      data: { sourceSessionId: 'source-1' },
    };

    // Act. The first attempt writes the source's event and then CRASHES before the replacement's —
    // the exact window the port's contract exists for.
    await appendHandoverEventOnce(opened.storage, serial, sourceAppend);
    // ...the replacement's append never happened. The step is now replayed from the top, as the
    // reconciler replays it after a restart: both appends are attempted again, in order.
    await appendHandoverEventOnce(opened.storage, serial, sourceAppend);
    await appendHandoverEventOnce(opened.storage, serial, replacementAppend);

    // Assert: exactly one completion in each journal, despite the source having been attempted twice.
    const sourceEvents = await completions(opened.storage, SOURCE);
    const replacementEvents = await completions(opened.storage, REPLACEMENT);
    should(sourceEvents).have.length(1);
    should(replacementEvents).have.length(1);
    // The ORDER is the contract's, and this is where it is visible: the source's completion was already
    // durable when the crash happened, and the replacement's was written only on the replay after it.
    // So the source's event survives the replay unduplicated while the replacement's appears exactly
    // once — which is what stops a reader ever finding a session welcomed by a predecessor that had not
    // yet recorded standing down.
    should(sourceEvents[0]?.type).equal(COMPLETED);
    should(replacementEvents[0]?.type).equal(COMPLETED);
    // Each event still carries the operation id that made it recognisable, which is what a later
    // replay matches against. The row is EXTRACTED first rather than reached through `?.` and then
    // dereferenced: mixing an optional element access with a non-optional property read throws a
    // TypeError when the element is absent, which would report a missing event as a crashed test
    // instead of as the failed assertion it is.
    should(operationIdOf(sourceEvents[0])).equal('handover-op:source');
    should(operationIdOf(replacementEvents[0])).equal('handover-op:replacement');

    await opened.storage.close();
  });

  it('should keep two genuinely different operations on one session, rather than deduplicating by type', async () => {
    // The id is what identifies an operation, not the event type: a session that is handed over, and
    // later is the SOURCE of a second handover, must record both. Matching on type alone would silently
    // drop the second one and leave the fleet's history claiming it never happened.
    // Arrange
    const opened = await openStorage();
    await opened.storage.writeConfig(SOURCE, config('source-1'));
    await opened.storage.writeState(SOURCE, { id: 'source-1', status: 'running' });

    // Act
    const base = { sessionId: 'source-1', type: COMPLETED, data: {} };
    await appendHandoverEventOnce(opened.storage, serial, { ...base, operationId: 'handover-1:source' });
    await appendHandoverEventOnce(opened.storage, serial, { ...base, operationId: 'handover-2:source' });
    // ...and a replay of the first is still refused.
    await appendHandoverEventOnce(opened.storage, serial, { ...base, operationId: 'handover-1:source' });

    // Assert
    const events = await completions(opened.storage, SOURCE);
    should(events.map(event => (event.data as Record<string, unknown>).operationId)).deepEqual([
      'handover-1:source',
      'handover-2:source',
    ]);

    await opened.storage.close();
  });

  it('should still deduplicate when more than one page of events precedes the completion', async () => {
    // THE REGRESSION THIS PINS. `replay` answers with a forward PREFIX, so a search that read one
    // bounded page would ask about the journal's OLDEST events while the completion it is looking for
    // is the NEWEST. On a session with more history than a page that search finds nothing every time,
    // and "at most once" silently becomes "once per restart" — on exactly the long-lived sessions a
    // handover is most likely to be retiring.
    // Arrange: more than one page of ordinary events, then the completion.
    const opened = await openStorage();
    await opened.storage.writeConfig(SOURCE, config('source-1'));
    await opened.storage.writeState(SOURCE, { id: 'source-1', status: 'running' });
    for (let index = 0; index < 1_050; index += 1) {
      await opened.storage.append(SOURCE, 'session.turn', { index });
    }
    const append = {
      sessionId: 'source-1',
      operationId: 'handover-op:source',
      type: COMPLETED,
      data: { replacementSessionId: 'replacement-1' },
    };

    // Act: write it, then invoke the same operation again exactly as a restart replays it.
    await appendHandoverEventOnce(opened.storage, serial, append);
    await appendHandoverEventOnce(opened.storage, serial, append);

    // Assert
    should(await completions(opened.storage, SOURCE)).have.length(1);

    await opened.storage.close();
    // The generous budget is for the ARRANGE step: writing a thousand durable events one at a time
    // costs a few seconds against real storage. The search itself walks two pages in milliseconds.
  }, 60_000);

  it('should write once when the same operation is attempted concurrently, not once per caller', async () => {
    // THE OTHER HALF OF "AT MOST ONCE". The durable journal answers the RESTART case; this answers the
    // CONCURRENT one. `DaemonStorage` locks each `replay` and each `append` separately, so without a
    // per-session critical section two attempts at the same operation — a route-triggered advance and
    // a reconciler tick landing together, which is an ordinary occurrence — can BOTH finish scanning,
    // each finding nothing because neither has written yet, and then both append.
    // Arrange
    const opened = await openStorage();
    await opened.storage.writeConfig(SOURCE, config('source-1'));
    await opened.storage.writeState(SOURCE, { id: 'source-1', status: 'running' });
    const append = {
      sessionId: 'source-1',
      operationId: 'handover-op:source',
      type: COMPLETED,
      data: { replacementSessionId: 'replacement-1' },
    };

    // Act: four callers race for the same operation.
    await Promise.all([
      appendHandoverEventOnce(opened.storage, serial, append),
      appendHandoverEventOnce(opened.storage, serial, append),
      appendHandoverEventOnce(opened.storage, serial, append),
      appendHandoverEventOnce(opened.storage, serial, append),
    ]);

    // Assert
    should(await completions(opened.storage, SOURCE)).have.length(1);

    await opened.storage.close();
  });

  it('should refuse to journal against an id the state-home layout would not accept', async () => {
    // An id that is not a session is not a path. The append is dropped rather than turned into a
    // directory traversal, exactly as every other journal write in the composition root drops one.
    // Arrange
    const opened = await openStorage();
    await opened.storage.writeConfig(SOURCE, config('source-1'));
    await opened.storage.writeState(SOURCE, { id: 'source-1', status: 'running' });

    // Act
    await appendHandoverEventOnce(opened.storage, serial, {
      sessionId: '../../etc/passwd',
      operationId: 'handover-op:source',
      type: COMPLETED,
      data: {},
    });

    // Assert: nothing was written anywhere this test can see.
    should(await completions(opened.storage, SOURCE)).be.empty();

    await opened.storage.close();
  });
});
