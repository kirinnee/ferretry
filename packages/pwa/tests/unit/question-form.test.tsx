import { describe, expect, test } from 'bun:test';
import { FyHttpError } from '@ferretry/protocol/client';
import { QuestionForm } from '../../src/components/question-form.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { render, run, runAsync } from '../support/react.ts';

const daemonA = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'https://a.invalid', deviceId: 'token-a' });
const daemonB = daemonConnection({ daemonId: 'daemon-b', baseUrl: 'https://b.invalid', deviceId: 'token-b' });

describe('QuestionForm', () => {
  test('pages a multi-question phone form and preserves every embedded multi-select label', async () => {
    const calls: unknown[][] = [];
    const form = render(
      <QuestionForm
        api={{ answer: async (...args) => calls.push(args) as never }}
        compact
        daemon={daemonA}
        question={{
          toolUseId: 'ask-1',
          questions: [
            { question: 'Pick a direction', options: [{ label: 'North' }, { label: 'South' }], multiSelect: true },
            { question: 'Explain the choice', options: [{ label: 'Ship now' }] },
          ],
        }}
        sessionId="same-session"
      />,
    );
    expect(form.root.findAllByType('fieldset')).toHaveLength(1);
    expect(form.root.findAllByType('input').every(input => input.props.type === 'checkbox')).toBe(true);
    run(() => form.root.findAllByType('input')[0]?.props.onChange());
    run(() => form.root.findAllByType('input')[1]?.props.onChange());
    run(() => form.root.findByProps({ children: 'Next' }).props.onClick());
    expect(form.root.findAll(item => item.children.join('') === 'Question 2 of 2')).toHaveLength(1);
    run(() => form.root.findAllByType('input')[0]?.props.onChange());
    await runAsync(async () => {
      form.root.findByProps({ children: 'Submit answers' }).props.onClick();
      await Promise.resolve();
    });
    expect(calls).toEqual([
      [
        daemonA,
        'same-session',
        'ask-1',
        [],
        undefined,
        ['North', 'Ship now'],
        [
          { kind: 'selection', labels: ['North', 'South'] },
          { kind: 'selection', labels: ['Ship now'] },
        ],
        expect.stringMatching(/^question:daemon-a:same-session:ask-1:[0-9a-f]{32}$/u),
      ],
    ]);
  });

  test('uses checkboxes only for a single multi-select question and keeps same session ids isolated by daemon', async () => {
    const calls: unknown[][] = [];
    const form = render(
      <QuestionForm
        api={{ answer: async (...args) => calls.push(args) as never }}
        daemon={daemonA}
        question={{
          toolUseId: 'ask-a',
          questions: [{ question: 'Select', options: [{ label: 'One' }, { label: 'Two' }], multiSelect: true }],
        }}
        sessionId="same-session"
      />,
    );
    expect(form.root.findAllByType('input').every(input => input.props.type === 'checkbox')).toBe(true);
    run(() => form.root.findAllByType('input')[0]?.props.onChange());
    run(() => form.root.findAllByType('input')[1]?.props.onChange());
    run(() =>
      form.update(
        <QuestionForm
          api={{ answer: async (...args) => calls.push(args) as never }}
          daemon={daemonB}
          question={{ toolUseId: 'ask-b', questions: [{ question: 'Select', options: [{ label: 'One' }] }] }}
          sessionId="same-session"
        />,
      ),
    );
    expect(form.root.findByType('button').props.disabled).toBe(true);
    run(() => form.root.findAllByType('input')[0]?.props.onChange());
    await runAsync(async () => {
      form.root.findByType('button').props.onClick();
      await Promise.resolve();
    });
    expect(calls).toEqual([
      [
        daemonB,
        'same-session',
        'ask-b',
        ['One'],
        undefined,
        undefined,
        [{ kind: 'selection', labels: ['One'] }],
        expect.stringMatching(/^question:daemon-b:same-session:ask-b:[0-9a-f]{32}$/u),
      ],
    ]);
  });

  // THE RETRY MUST CARRY THE SAME KEY, and that is not a cosmetic detail about this component: the
  // daemon joins a retried answer to the attempt already in flight, and replays a settled one, by
  // this exact string. A freshly minted id on the second submit would present the daemon with a
  // second, unrelated answer and drive the live form a second time. So the id is asserted here, at
  // the only place that decides it.
  test('keeps the form usable after a failed response and retries under the identical request id', async () => {
    let attempts = 0;
    const requestIds: unknown[] = [];
    const form = render(
      <QuestionForm
        api={{
          answer: async (_daemon, _sessionId, _toolUseId, _labels, _other, _responses, _answers, requestId) => {
            attempts += 1;
            requestIds.push(requestId);
            if (attempts === 1) throw new Error('offline');
          },
        }}
        daemon={daemonA}
        question={{ toolUseId: 'retry', questions: [{ question: 'Proceed?', options: [{ label: 'Yes' }] }] }}
        sessionId="retry-session"
      />,
    );
    run(() => form.root.findAllByType('input')[0]?.props.onChange());
    await runAsync(async () => {
      form.root.findByType('button').props.onClick();
      await Promise.resolve();
    });
    expect(form.root.findByProps({ role: 'alert' }).children).toContain('offline');
    await runAsync(async () => {
      form.root.findByType('button').props.onClick();
      await Promise.resolve();
    });
    expect(attempts).toBe(2);
    expect(requestIds[0]).toMatch(/^question:daemon-a:retry-session:retry:[0-9a-f]{32}$/u);
    expect(requestIds[0]).toBe(requestIds[1]);
  });

  // THE KEY NAMES ONE ANSWER, NOT ONE QUESTION. The daemon refuses a key reused with a different body
  // for good, so a question-only key turned every second attempt with a changed choice into a
  // permanent error. The digest makes a repeat idempotent and a different answer a new attempt.
  test('mints a new request id for a changed answer and the same one for an identical retry', async () => {
    const requestIds: string[] = [];
    const form = render(
      <QuestionForm
        api={{
          answer: async (_daemon, _sessionId, _toolUseId, _labels, _other, _responses, _answers, requestId) => {
            requestIds.push(requestId ?? '');
            throw new Error('offline');
          },
        }}
        daemon={daemonA}
        question={{
          toolUseId: 'changed',
          questions: [{ question: 'Proceed?', options: [{ label: 'Yes' }, { label: 'No' }] }],
        }}
        sessionId="changed-session"
      />,
    );
    const submit = async () =>
      await runAsync(async () => {
        form.root.findByType('button').props.onClick();
        await Promise.resolve();
      });
    run(() => form.root.findAllByType('input')[0]?.props.onChange());
    await submit();
    await submit();
    run(() => form.root.findAllByType('input')[1]?.props.onChange());
    await submit();
    run(() => form.root.findAllByType('input')[2]?.props.onChange());
    run(() => form.root.findByType('textarea').props.onChange({ currentTarget: { value: 'first words' } }));
    await submit();
    run(() => form.root.findByType('textarea').props.onChange({ currentTarget: { value: 'edited words' } }));
    await submit();

    expect(requestIds).toHaveLength(5);
    expect(requestIds[0]).toBe(requestIds[1]);
    expect(new Set(requestIds).size).toBe(4);
  });

  test('shows the daemon answered state read-only when the question was already answered', async () => {
    const form = render(
      <QuestionForm
        api={{
          answer: async () => {
            throw new FyHttpError('This question was already answered with «Yes».', 409, 'question_already_answered', {
              error: 'x',
              code: 'question_already_answered',
              answeredWith: 'Yes',
              detail: 'raw',
            });
          },
        }}
        daemon={daemonA}
        question={{
          toolUseId: 'done',
          questions: [{ question: 'Proceed?', options: [{ label: 'Yes' }, { label: 'No' }] }],
        }}
        sessionId="done-session"
      />,
    );
    run(() => form.root.findAllByType('input')[1]?.props.onChange());
    await runAsync(async () => {
      form.root.findByType('button').props.onClick();
      await Promise.resolve();
    });

    const status = form.root.findByProps({ 'data-question-answered': '' });
    expect(status.children.join('')).toBe('This question was already answered with «Yes».');
    expect(form.root.findAllByProps({ role: 'alert' })).toHaveLength(0);
    expect(form.root.findAllByType('input').every(input => input.props.disabled === true)).toBe(true);
    expect(form.root.findByType('button').props.disabled).toBe(true);
  });

  test('keeps the technical explanation in Details, never in the sentence', async () => {
    const form = render(
      <QuestionForm
        api={{
          answer: async () => {
            throw new FyHttpError(
              'A different answer was already sent for this question.',
              409,
              'answer_request_id_reused',
              {
                error: 'x',
                detail: 'request id "question:a" was already used for a different answer',
              },
            );
          },
        }}
        daemon={daemonA}
        question={{ toolUseId: 'raw', questions: [{ question: 'Proceed?', options: [{ label: 'Yes' }] }] }}
        sessionId="raw-session"
      />,
    );
    run(() => form.root.findAllByType('input')[0]?.props.onChange());
    await runAsync(async () => {
      form.root.findByType('button').props.onClick();
      await Promise.resolve();
    });

    expect(form.root.findByProps({ role: 'alert' }).children.join('')).toBe(
      'A different answer was already sent for this question.',
    );
    expect(form.root.findByType('summary').children.join('')).toBe('Details');
    expect(form.root.findByType('pre').children.join('')).toMatch(/already used for a different answer/u);
  });

  /** Submits "Yes" on a form whose answer is refused with `cause`, opening the Console through `opened`. */
  async function refusedWith(cause: unknown, opened?: string[]) {
    const form = render(
      <QuestionForm
        api={{
          answer: async () => {
            throw cause;
          },
        }}
        daemon={daemonA}
        {...(opened === undefined ? {} : { onOpenConsole: () => opened.push('console') })}
        question={{ toolUseId: 'stuck', questions: [{ question: 'Proceed?', options: [{ label: 'Yes' }] }] }}
        sessionId="stuck-session"
      />,
    );
    run(() => form.root.findAllByType('input')[0]?.props.onChange());
    await runAsync(async () => {
      form.root.findByProps({ className: 'fy-question-submit' }).props.onClick();
      await Promise.resolve();
    });
    return form;
  }

  const DRIVER_TEXT =
    'the rendered form is not the exact pending question; no keys were sent\n\nAutomatic native cancellation was not confirmed';

  test("turns an older daemon's raw driver text into a sentence a person can act on, keeping the text in Details", async () => {
    const opened: string[] = [];
    const form = await refusedWith(
      new FyHttpError(DRIVER_TEXT, 409, 'answer_unconfirmed', { error: DRIVER_TEXT }),
      opened,
    );

    expect(form.root.findByProps({ role: 'alert' }).children.join('')).toBe(
      "Couldn't answer automatically — answer in the Console tab or type your choice in chat.",
    );
    expect(form.root.findByType('pre').children.join('')).toBe(DRIVER_TEXT);
    run(() => form.root.findByProps({ className: 'fy-question-console' }).props.onClick());
    expect(opened).toEqual(['console']);
  });

  test.each([
    ['answer_unconfirmed', 409],
    ['answer_released', 409],
    ['session_answer_failed', 500],
  ])('keeps a daemon-worded sentence for %s and still offers the Console', async (code, status) => {
    const form = await refusedWith(
      new FyHttpError("Couldn't answer automatically.", status, code, { error: 'x', detail: DRIVER_TEXT }),
      [],
    );

    expect(form.root.findByProps({ role: 'alert' }).children.join('')).toBe("Couldn't answer automatically.");
    expect(form.root.findByType('pre').children.join('')).toBe(DRIVER_TEXT);
    expect(form.root.findAllByProps({ className: 'fy-question-console' })).toHaveLength(1);
  });

  test('offers no Console button where the host has none, or for a refusal that is not about the pane', async () => {
    const hostless = await refusedWith(new FyHttpError(DRIVER_TEXT, 409, 'answer_unconfirmed'));
    const refused = await refusedWith(new FyHttpError('Reload the app.', 409, 'answer_request_id_reused'), []);
    const offline = await refusedWith(new Error('network down'), []);

    expect(hostless.root.findAllByProps({ className: 'fy-question-console' })).toHaveLength(0);
    expect(refused.root.findAllByProps({ className: 'fy-question-console' })).toHaveLength(0);
    expect(refused.root.findByProps({ role: 'alert' }).children.join('')).toBe('Reload the app.');
    expect(offline.root.findByProps({ role: 'alert' }).children.join('')).toBe('network down');
  });

  const PAUSED_SENTENCE =
    'Stopped at question 2 of 2 (1 of 2 answered). Nothing was sent yet and the form is still open: resume to answer the rest, or finish it in the Console tab.';

  test('shows which questions a paused drive left answered in the terminal, and resumes with the same answer', async () => {
    const calls: unknown[][] = [];
    const opened: string[] = [];
    let refuse = true;
    const form = render(
      <QuestionForm
        api={{
          answer: async (...args) => {
            calls.push(args);
            if (refuse)
              throw new FyHttpError(PAUSED_SENTENCE, 409, 'answer_paused', {
                error: PAUSED_SENTENCE,
                detail: 'stopped at question 2 of 2 (Extras): the answer keys were sent',
                stoppedAt: 1,
                answered: [true, false],
              });
            return undefined;
          },
        }}
        daemon={daemonA}
        onOpenConsole={() => opened.push('console')}
        question={{
          toolUseId: 'tabs',
          questions: [
            { header: 'Colour', question: 'Which colour?', options: [{ label: 'Red' }, { label: 'Blue' }] },
            { header: 'Extras', question: 'Which extras?', options: [{ label: 'Shadow' }] },
          ],
        }}
        sessionId="tabs-session"
      />,
    );
    run(() => form.root.findAllByType('input')[1]?.props.onChange());
    run(() => form.root.findAllByType('input')[3]?.props.onChange());
    await runAsync(async () => {
      form.root.findByProps({ className: 'fy-question-submit' }).props.onClick();
      await Promise.resolve();
    });

    expect(form.root.findByProps({ role: 'alert' }).children.join('')).toBe(PAUSED_SENTENCE);
    // Only the first question carries the mark.
    const held = form.root.findAllByProps({ 'data-question-held': '' });
    expect(held).toHaveLength(1);
    expect(form.root.findAllByType('fieldset')[0]?.findAllByProps({ 'data-question-held': '' })).toHaveLength(1);
    expect(form.root.findByType('pre').children.join('')).toMatch(/stopped at question 2 of 2 \(Extras\)/u);
    run(() => form.root.findByProps({ className: 'fy-question-console' }).props.onClick());
    expect(opened).toEqual(['console']);

    refuse = false;
    await runAsync(async () => {
      form.root.findByProps({ className: 'fy-question-resume' }).props.onClick();
      await Promise.resolve();
    });

    // The same answer under the same request id: the daemon admits it again, because nothing was submitted.
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    expect(form.root.findAllByProps({ role: 'alert' })).toHaveLength(0);
    expect(form.root.findAllByProps({ 'data-question-held': '' })).toHaveLength(0);
  });

  test('still offers Resume and the Console when a paused refusal carries no usable progress', async () => {
    const form = await refusedWith(
      new FyHttpError(PAUSED_SENTENCE, 409, 'answer_paused', { error: PAUSED_SENTENCE, answered: ['yes'] }),
      [],
    );

    expect(form.root.findAllByProps({ 'data-question-held': '' })).toHaveLength(0);
    expect(form.root.findAllByProps({ className: 'fy-question-resume' })).toHaveLength(1);
    expect(form.root.findAllByProps({ className: 'fy-question-console' })).toHaveLength(1);
    expect(form.root.findAllByType('pre')).toHaveLength(0);
  });

  test('makes Other exclusive, renders its text field, and submits its trimmed value', async () => {
    const calls: unknown[][] = [];
    const form = render(
      <QuestionForm
        api={{ answer: async (...args) => calls.push(args) as never }}
        daemon={daemonA}
        question={{ toolUseId: 'other', questions: [{ question: 'What else?', options: [{ label: 'Known option' }] }] }}
        sessionId="other-session"
      />,
    );
    run(() => form.root.findAllByType('input')[1]?.props.onChange());
    const field = form.root.findByType('textarea');
    run(() => field.props.onChange({ currentTarget: { value: '  A freeform response  ' } }));
    await runAsync(async () => {
      form.root.findByType('button').props.onClick();
      await Promise.resolve();
    });
    expect(calls).toEqual([
      [
        daemonA,
        'other-session',
        'other',
        [],
        'A freeform response',
        undefined,
        [{ kind: 'other', text: 'A freeform response' }],
        expect.stringMatching(/^question:daemon-a:other-session:other:[0-9a-f]{32}$/u),
      ],
    ]);
  });

  test('reads the typed Other text while the event is live, because React clears currentTarget afterwards', () => {
    const form = render(
      <QuestionForm
        api={{ answer: async () => ({}) }}
        daemon={daemonA}
        question={{ toolUseId: 'live', questions: [{ question: 'What else?', options: [{ label: 'Known option' }] }] }}
        sessionId="live-session"
      />,
    );
    run(() => form.root.findAllByType('input')[1]?.props.onChange());
    let live = true;
    const event = {
      get currentTarget() {
        return live ? { value: 'typed' } : null;
      },
    };
    run(() => {
      form.root.findByType('textarea').props.onChange(event);
      live = false;
    });
    expect(form.root.findByType('textarea').props.value).toBe('typed');
  });
});
