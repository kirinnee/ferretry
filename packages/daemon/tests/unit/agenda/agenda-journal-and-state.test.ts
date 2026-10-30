import { describe, it } from 'bun:test';
import { SessionStateSchema } from '@ferretry/protocol';
import should from 'should';
import {
  AGENDA_CHANGED_EVENT,
  StorageSessionAgendaState,
} from '../../../src/adapters/agenda/storage-session-agenda-state.ts';
import { AGENDA_NUDGED_EVENT } from '../../../src/adapters/agenda/storage-agenda-nudge.ts';
import { HARNESS_ANSWER_FAILED_EVENT } from '../../../src/adapters/agenda/storage-harness-prompt.ts';
import type { AgendaBoardChange } from '../../../src/lib/agenda/index.ts';
import type { FrozenJsonValue } from '../../../src/lib/json.ts';

/**
 * The agenda wire's two daemon-side writes on a session's own record: the summary under BOTH names, and the
 * journal events under the new ones. An app from before `agenda.wire.1` reads only `attention`; one after
 * reads `agenda ?? attention`; neither may lose the other's field while the old routes are served.
 */

const SUMMARY = { open: 2, first: 'A1', ask: 'Rebase onto main now?', latestAt: '2026-10-23T10:00:00.000Z' } as const;

type Document = Record<string, FrozenJsonValue>;

/** The three storage calls the adapter makes, over one in-memory state document and journal. */
function storageOver(initial: Document | undefined) {
  let state = initial;
  const journal: Array<{ readonly type: string; readonly data: unknown }> = [];
  const storage = {
    readState: async () => state as FrozenJsonValue | undefined,
    updateState: async (_id: unknown, change: (latest: FrozenJsonValue | undefined) => FrozenJsonValue) => {
      state = change(state) as Document;
    },
    append: async (_id: unknown, type: string, data: unknown) => {
      journal.push({ type, data });
    },
  };
  return { storage: storage as never, state: () => state, journal };
}

const change = (kind: AgendaBoardChange['change'], id: string): AgendaBoardChange =>
  ({ change: kind, actor: { kind: 'human' }, via: 'board', item: { id } }) as unknown as AgendaBoardChange;

const BASE: Document = { id: 'session-1', status: 'running', turn: 1 };

describe('the journal entries a board leaves', () => {
  it('should be named for the agenda, so `fy events` shows the new names', () => {
    should([AGENDA_CHANGED_EVENT, AGENDA_NUDGED_EVENT, HARNESS_ANSWER_FAILED_EVENT]).deepEqual([
      'agenda.changed',
      'agenda.nudged',
      'agenda.harness_answer_failed',
    ]);
  });
});

describe('the session summary under both names', () => {
  it('should write the same summary as `agenda` and `attention` and parse under the protocol', async () => {
    // Arrange
    const { storage, state, journal } = storageOver({ ...BASE });

    // Act
    await new StorageSessionAgendaState(storage).write('session-1', SUMMARY, change('created', 'A2'));

    // Assert
    const parsed = SessionStateSchema.parse(state());
    should(parsed.attention).deepEqual(SUMMARY);
    should(parsed.agenda).deepEqual(SUMMARY);
    should(state()?.attention).deepEqual(state()?.agenda);
    should(journal).deepEqual([{ type: 'agenda.changed', data: { change: 'created', id: 'A2', open: 2 } }]);
  });

  it('should clear both to ABSENT, never null', async () => {
    // Arrange
    const { storage, state } = storageOver({ ...BASE, attention: { ...SUMMARY }, agenda: { ...SUMMARY } });

    // Act
    await new StorageSessionAgendaState(storage).write('session-1', undefined, change('answered', 'A1'));

    // Assert
    should(state()).not.have.property('attention');
    should(state()).not.have.property('agenda');
    should(SessionStateSchema.safeParse(state()).success).be.true();
  });

  it('should backfill `agenda` on a document written before it, without a journal entry for a quiet reconcile', async () => {
    // Arrange — a state document from a daemon that wrote only the old name
    const { storage, state, journal } = storageOver({ ...BASE, attention: { ...SUMMARY } });

    // Act
    await new StorageSessionAgendaState(storage).write('session-1', SUMMARY, undefined);

    // Assert
    should(state()?.agenda).deepEqual(SUMMARY);
    should(state()?.attention).deepEqual(SUMMARY);
    should(journal).deepEqual([{ type: 'agenda.changed', data: { change: 'reconciled', open: 2 } }]);
  });

  it('should leave a document that already holds both untouched and journal only a real change', async () => {
    // Arrange
    const { storage, journal } = storageOver({ ...BASE, attention: { ...SUMMARY }, agenda: { ...SUMMARY } });
    const subject = new StorageSessionAgendaState(storage);

    // Act
    await subject.write('session-1', SUMMARY, undefined);
    await subject.write('session-1', SUMMARY, change('replied', 'A1'));

    // Assert
    should(journal).deepEqual([{ type: 'agenda.changed', data: { change: 'replied', id: 'A1', open: 2 } }]);
  });

  it('should do nothing for an id the layout refuses or a session with no state', async () => {
    // Arrange
    const refused = storageOver({ ...BASE });
    const missing = storageOver(undefined);

    // Act
    await new StorageSessionAgendaState(refused.storage).write('../escape', SUMMARY, change('created', 'A1'));
    await new StorageSessionAgendaState(missing.storage).write('session-1', SUMMARY, change('created', 'A1'));

    // Assert
    should(refused.state()).deepEqual(BASE);
    should(refused.journal).deepEqual([]);
    should(missing.journal).deepEqual([]);
  });
});
