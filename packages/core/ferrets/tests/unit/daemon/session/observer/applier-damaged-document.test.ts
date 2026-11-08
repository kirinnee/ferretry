import { describe, it } from 'bun:test';
import should from 'should';
import { SessionObservationApplier } from '../../../../../daemon/adapters/session/observer/session-observation-applier.ts';
import { KeyedSerialExecutor } from '../../../../../daemon/adapters/storage/keyed-serial-executor.ts';
import { InvalidStateDocumentError } from '../../../../../daemon/adapters/storage/session-storage.ts';
import { stepQuestion } from '../../../../../daemon/lib/session/observer/question.ts';
import type { SessionState } from '../../../../../daemon/lib/protocol/session.ts';
import type { TranscriptEvent } from '../../../../../daemon/lib/session/peers/transcript.ts';
import { parseSessionId } from '../../../../../daemon/lib/session-id.ts';
import { SCRIPTED_QUESTIONS } from '../../../../support/daemon/observer-stand-ins.ts';

const AT = '2026-10-22T08:00:00.000Z';
const ID = parseSessionId('damaged-1');
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

describe('SessionObservationApplier over a damaged state document', () => {
  it('should write nothing and answer false when storage refuses the document it holds the lock on', async () => {
    // Arrange — storage reads through the schema, so a damaged document is refused rather than handed over raw.
    const patch = stepQuestion(
      { state: { id: ID, status: 'running', turn: 1 } as SessionState, events: [asked], answers: new Map() },
      SCRIPTED_QUESTIONS,
    );
    if (patch === undefined) throw new Error('the look implied nothing');
    const storage = {
      updateState: async () => {
        throw new InvalidStateDocumentError('damaged-1/state.json', 'does not match its schema');
      },
      append: async () => undefined,
    };
    const subject = new SessionObservationApplier(
      storage as never,
      { all: async () => new Map(), append: async () => undefined },
      new KeyedSerialExecutor(),
      SCRIPTED_QUESTIONS,
    );

    // Act
    const written = await subject.apply(ID, patch, AT);

    // Assert
    should(written).be.false();
  });

  it('should still raise any other storage failure', async () => {
    // Arrange
    const patch = stepQuestion(
      { state: { id: ID, status: 'running', turn: 1 } as SessionState, events: [asked], answers: new Map() },
      SCRIPTED_QUESTIONS,
    );
    if (patch === undefined) throw new Error('the look implied nothing');
    const subject = new SessionObservationApplier(
      {
        updateState: async () => {
          throw new Error('disk gone');
        },
        append: async () => undefined,
      } as never,
      { all: async () => new Map(), append: async () => undefined },
      new KeyedSerialExecutor(),
      SCRIPTED_QUESTIONS,
    );

    // Act / Assert
    await should(subject.apply(ID, patch, AT)).be.rejectedWith('disk gone');
  });
});
