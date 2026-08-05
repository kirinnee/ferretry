import { describe, expect, test } from 'bun:test';
import { QuestionForm } from '../../src/components/question-form.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { render, run, runAsync } from '../support/react.ts';

const daemonA = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'https://a.invalid', deviceToken: 'token-a' });
const daemonB = daemonConnection({ daemonId: 'daemon-b', baseUrl: 'https://b.invalid', deviceToken: 'token-b' });

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
        'question:daemon-a:same-session:ask-1',
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
        'question:daemon-b:same-session:ask-b',
      ],
    ]);
  });

  test('keeps the form usable after a failed response', async () => {
    let attempts = 0;
    const form = render(
      <QuestionForm
        api={{
          answer: async () => {
            attempts += 1;
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
        'question:daemon-a:other-session:other',
      ],
    ]);
  });
});
