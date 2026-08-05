import { describe, it } from 'bun:test';
import type { PendingQuestion, StructuredQuestionAnswer } from '@ferretry/protocol';
import should from 'should';
import {
  type StructuredQuestionDriver,
  StructuredQuestionRefused,
  type StructuredQuestionRepository,
  StructuredQuestionService,
} from '../../../../src/lib/session/question/service.ts';
import { parseSessionId } from '../../../../src/lib/session-id.ts';

const ID = parseSessionId('session-1');
const pending: PendingQuestion = {
  toolUseId: 'question-1',
  questions: [
    { question: 'Deploy?', options: [{ label: 'Yes' }, { label: 'No' }] },
    { question: 'Targets?', options: [{ label: 'Web' }, { label: 'API' }], multiSelect: true },
  ],
};

class Answers implements StructuredQuestionRepository {
  readonly delivered: Array<
    readonly [string, string, readonly StructuredQuestionAnswer[], { readonly confirmedBy: string }]
  > = [];

  constructor(private readonly question: PendingQuestion | undefined = pending) {}

  async pending(): Promise<PendingQuestion | undefined> {
    return this.question;
  }

  async answered(
    id: string,
    toolUseId: string,
    answers: readonly StructuredQuestionAnswer[],
    confirmation: { readonly confirmedBy: string },
  ): Promise<void> {
    this.delivered.push([id, toolUseId, answers, confirmation]);
  }
}

class Driver implements StructuredQuestionDriver {
  readonly calls: Array<readonly StructuredQuestionAnswer[]> = [];

  constructor(
    private readonly result: Promise<{ readonly confirmedBy: 'prompt-ready' }> = Promise.resolve({
      confirmedBy: 'prompt-ready',
    }),
  ) {}

  async drive(
    _id: typeof ID,
    _question: PendingQuestion,
    answers: readonly StructuredQuestionAnswer[],
  ): Promise<{ readonly confirmedBy: 'prompt-ready' }> {
    this.calls.push(answers);
    return this.result;
  }
}

function subject(question: PendingQuestion | undefined = pending, driver = new Driver()) {
  const repository = new Answers(question);
  return { repository, driver, service: new StructuredQuestionService(repository, driver) };
}

describe('structured question service', () => {
  it('validates all answers, visibly drives them, then clears the exact durable question', async () => {
    const { service, repository, driver } = subject();

    await service.answer({
      id: ID,
      toolUseId: 'question-1',
      labels: [],
      answers: [
        { kind: 'selection', labels: ['Yes'] },
        { kind: 'selection', labels: ['Web', 'API'] },
      ],
    });

    should(driver.calls).deepEqual([
      [
        { kind: 'selection', labels: ['Yes'] },
        { kind: 'selection', labels: ['Web', 'API'] },
      ],
    ]);
    should(repository.delivered).deepEqual([
      [
        'session-1',
        'question-1',
        [
          { kind: 'selection', labels: ['Yes'] },
          { kind: 'selection', labels: ['Web', 'API'] },
        ],
        { confirmedBy: 'prompt-ready' },
      ],
    ]);
  });

  it('does not clear the stored question when the pane cannot confirm the answer', async () => {
    const confirmationFailure = Promise.reject(
      new Error('the answer keys were sent, but the rendered form did not visibly advance'),
    );
    const { service, repository } = subject(pending, new Driver(confirmationFailure));

    await should(
      service.answer({
        id: ID,
        toolUseId: 'question-1',
        labels: [],
        answers: [
          { kind: 'selection', labels: ['Yes'] },
          { kind: 'selection', labels: ['Web'] },
        ],
      }),
    ).be.rejectedWith(/did not visibly advance/u);
    should(repository.delivered).deepEqual([]);
  });

  it('supports the legacy one-question and multi-question payloads without weakening validation', async () => {
    const single: PendingQuestion = {
      toolUseId: 'single',
      questions: [{ question: 'Deploy?', options: [{ label: 'Yes' }, { label: 'No' }] }],
    };
    const legacy = subject(single);
    await legacy.service.answer({ id: ID, toolUseId: 'single', labels: ['No'] });
    should(legacy.repository.delivered[0]?.[2]).deepEqual([{ kind: 'selection', labels: ['No'] }]);

    const freeform = subject(single);
    await freeform.service.answer({ id: ID, toolUseId: 'single', labels: [], other: ' because it is ready ' });
    should(freeform.repository.delivered[0]?.[2]).deepEqual([{ kind: 'other', text: 'because it is ready' }]);

    const responses = subject();
    await responses.service.answer({
      id: ID,
      toolUseId: 'question-1',
      labels: [],
      responses: ['Yes', 'a custom target'],
    });
    should(responses.repository.delivered[0]?.[2]).deepEqual([
      { kind: 'selection', labels: ['Yes'] },
      { kind: 'other', text: 'a custom target' },
    ]);
  });

  it('refuses stale, missing, malformed, and ambiguous answers before sending any keys', async () => {
    const missing = subject(undefined);
    await should(missing.service.answer({ id: ID, toolUseId: 'question-1', labels: [] })).be.rejectedWith(
      StructuredQuestionRefused,
    );

    const stale = subject();
    await should(stale.service.answer({ id: ID, toolUseId: 'old-question', labels: [] })).be.rejectedWith(
      /changed before/u,
    );

    for (const answers of [
      [{ kind: 'selection' as const, labels: ['Yes'] }],
      [
        { kind: 'selection' as const, labels: ['Yes', 'No'] },
        { kind: 'selection' as const, labels: ['Web'] },
      ],
      [
        { kind: 'selection' as const, labels: ['Maybe'] },
        { kind: 'selection' as const, labels: ['Web'] },
      ],
      [
        { kind: 'selection' as const, labels: ['Yes'] },
        { kind: 'selection' as const, labels: ['Web', 'Web'] },
      ],
      [
        { kind: 'other' as const, text: ' ' },
        { kind: 'selection' as const, labels: ['Web'] },
      ],
    ]) {
      const invalid = subject();
      await should(invalid.service.answer({ id: ID, toolUseId: 'question-1', labels: [], answers })).be.rejectedWith(
        StructuredQuestionRefused,
      );
      should(invalid.driver.calls).deepEqual([]);
      should(invalid.repository.delivered).deepEqual([]);
    }

    const legacy = subject();
    await should(legacy.service.answer({ id: ID, toolUseId: 'question-1', labels: ['Yes'] })).be.rejectedWith(
      /requires one answer/u,
    );
    await should(
      legacy.service.answer({ id: ID, toolUseId: 'question-1', labels: [], responses: ['Yes'] }),
    ).be.rejectedWith(/expected 2 answers/u);
  });
});
