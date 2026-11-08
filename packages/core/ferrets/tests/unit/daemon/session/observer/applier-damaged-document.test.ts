import { afterEach, describe, it } from 'bun:test';
import should from 'should';
import { FerretStateFile } from '../../../../../contract/index.ts';
import { SessionObservationApplier } from '../../../../../daemon/adapters/session/observer/session-observation-applier.ts';
import { KeyedSerialExecutor } from '../../../../../daemon/adapters/storage/keyed-serial-executor.ts';
import type { SessionState } from '../../../../../daemon/lib/protocol/session.ts';
import { stepQuestion } from '../../../../../daemon/lib/session/observer/question.ts';
import type { TranscriptEvent } from '../../../../../daemon/lib/session/peers/transcript.ts';
import { parseSessionId } from '../../../../../daemon/lib/session-id.ts';
import { SCRIPTED_QUESTIONS } from '../../../../support/daemon/observer-stand-ins.ts';
import { memoryStorage } from '../../../../support/daemon/storage.ts';

const AT = '2026-10-22T08:00:00.000Z';
const ID = parseSessionId('damaged-1');
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const asked: TranscriptEvent = {
  kind: 'tool-call',
  harness: 'claude',
  role: 'assistant',
  timestamp: AT,
  call: {
    id: 'tool-1',
    name: 'AskUserQuestion',
    input: {},
    questions: [{ question: 'Ship?', options: [{ label: 'Yes' }, { label: 'No' }], multiple: false }],
  },
};

// No guarantees row covers this rule (docs/rebuild/guarantees.tsv names none); the test pins today's behaviour.
describe('SessionObservationApplier over a damaged state document (no guarantees row)', () => {
  it('should write nothing, and not throw, over a state.json the schema refuses, under the lock', async () => {
    // Arrange
    const { storage, folder } = await memoryStorage({ clock: { now: () => AT } });
    cleanups.push(async () => await storage.close());
    const patch = stepQuestion(
      { state: { id: ID, status: 'running', turn: 1 } as SessionState, events: [asked], answers: new Map() },
      SCRIPTED_QUESTIONS,
    );
    if (patch === undefined) throw new Error('the look implied nothing');
    const subject = new SessionObservationApplier(
      storage,
      { all: async () => new Map(), append: async () => undefined },
      new KeyedSerialExecutor(),
      SCRIPTED_QUESTIONS,
    );
    const damaged = JSON.stringify({ format: 1, id: ID, status: 'not-a-status' });
    folder.plant(FerretStateFile, damaged, ID);

    // Act
    const written = await subject.apply(ID, patch, AT);

    // Assert
    should(written).be.false();
    should(folder.raw(FerretStateFile, ID)).equal(damaged);
  });
});
