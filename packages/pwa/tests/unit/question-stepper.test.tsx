import { describe, expect, test } from 'bun:test';
import type { PendingQuestion } from '@ferretry/protocol';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { QuestionForm } from '../../src/components/question-form.tsx';
import { QuestionDraftStore } from '../../src/components/question-form-model.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { render, run, runAsync } from '../support/react.ts';

const daemonA = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'https://a.invalid', deviceId: 'token-a' });
const daemonB = daemonConnection({ daemonId: 'daemon-b', baseUrl: 'https://b.invalid', deviceId: 'token-b' });

const FOUR: PendingQuestion = {
  toolUseId: 'four',
  questions: [
    {
      header: 'RWC socials',
      question: 'Which socials should the team plan around the Rugby World Cup final weekend?',
      options: [
        { label: 'Pub screening', description: 'Book the back room and a projector for the whole squad and partners.' },
        { label: 'Watch party at the office' },
      ],
    },
    { header: 'MX Weekly', question: 'Keep the weekly slot?', options: [{ label: 'Keep' }, { label: 'Move' }] },
    {
      header: 'Meet & Greet',
      question: 'Who should host the new-starter session?',
      options: [{ label: 'Team lead' }, { label: 'Buddy' }],
    },
    {
      header: 'Sprint plan',
      question: 'Which items are in?',
      options: [{ label: 'API' }, { label: 'UI' }],
      multiSelect: true,
    },
  ],
};

interface Harness {
  readonly form: ReactTestRenderer;
  readonly calls: unknown[][];
  readonly focused: string[];
  readonly drafts: QuestionDraftStore;
}

const mount = (
  question: PendingQuestion,
  drafts = new QuestionDraftStore(),
  options: { daemon?: typeof daemonA; answered?: () => void } = {},
): Harness => {
  const calls: unknown[][] = [];
  const focused: string[] = [];
  const form = render(
    <QuestionForm
      api={{ answer: async (...args) => calls.push(args) as never }}
      daemon={options.daemon ?? daemonA}
      drafts={drafts}
      {...(options.answered === undefined ? {} : { onAnswered: options.answered })}
      question={question}
      sessionId="session"
    />,
    {
      createNodeMock: element => ({
        focus: () => focused.push(String(element.type)),
        scrollIntoView: () => focused.push('scrolled'),
      }),
    },
  );
  return { form, calls, focused, drafts };
};

const eyebrow = (form: ReactTestRenderer): string =>
  form.root.findByProps({ className: 'fy-eyebrow' }).children.join('');
const button = (form: ReactTestRenderer, label: string) => {
  const found = form.root.findAllByType('button').filter(item => item.children.join('') === label);
  if (found.length !== 1) throw new Error(`expected one "${label}" button, found ${found.length}`);
  return found[0] as (typeof found)[number];
};
const pick = (form: ReactTestRenderer, index: number) =>
  run(() => form.root.findAllByType('input')[index]?.props.onChange());
const chip = (form: ReactTestRenderer, index: number) =>
  form.root.findAllByProps({ className: 'fy-question-step' })[index] as ReactTestInstance;
const enter = (input: ReactTestInstance, extra: object = {}) => {
  const log = { prevented: 0 };
  run(() =>
    input.props.onKeyDown({
      key: 'Enter',
      nativeEvent: { isComposing: false },
      preventDefault: () => {
        log.prevented += 1;
      },
      ...extra,
    }),
  );
  return log;
};

describe('QuestionForm stepper', () => {
  test('shows a single question as it is, with no stepper chrome', () => {
    const { form } = mount({ toolUseId: 'one', questions: [{ question: 'Ship it?', options: [{ label: 'Yes' }] }] });
    expect(form.root.findAllByType('header')).toHaveLength(0);
    expect(form.root.findAllByProps({ className: 'fy-question-nav' })).toHaveLength(0);
    expect(form.root.findAllByType('button')).toHaveLength(1);
    expect(form.root.findByProps({ className: 'fy-question-form' }).props['data-stepper']).toBeUndefined();
  });

  test('walks four questions with progress chips, keeps answers when going back, and ends in a review', () => {
    const { form } = mount(FOUR);
    expect(eyebrow(form)).toBe('Question 1 of 4');
    expect(form.root.findAllByProps({ className: 'fy-question-step' })).toHaveLength(5);
    expect(chip(form, 0).props['aria-current']).toBe('step');
    expect(chip(form, 0).props['aria-label']).toBe('Question 1 of 4, RWC socials, not answered');
    expect(button(form, 'Back').props.disabled).toBe(true);
    expect(button(form, 'Next').props.disabled).toBe(true);

    pick(form, 0);
    expect(chip(form, 0).props['data-answered']).toBe('true');
    expect(chip(form, 0).props['aria-label']).toBe('Question 1 of 4, RWC socials, answered');
    run(() => button(form, 'Next').props.onClick());
    expect(eyebrow(form)).toBe('Question 2 of 4');
    expect(form.root.findByType('legend').children.join('')).toBe('MX Weekly');
    run(() => button(form, 'Back').props.onClick());
    expect(form.root.findAllByType('input')[0]?.props.checked).toBe(true);
    expect(form.root.findAllByType('small').map(item => item.children.join(''))).toContain(
      'Book the back room and a projector for the whole squad and partners.',
    );
  });

  test('jumps by chip, lists every answer on the review page and lets each one be changed', async () => {
    const { form, calls } = mount(FOUR);
    pick(form, 1);
    run(() => chip(form, 1).props.onClick());
    pick(form, 0);
    run(() => chip(form, 2).props.onClick());
    pick(form, 1);
    run(() => chip(form, 3).props.onClick());
    pick(form, 0);
    pick(form, 1);
    run(() => button(form, 'Review').props.onClick());

    expect(eyebrow(form)).toBe('Review · 4 questions');
    const rows = form.root.findAllByProps({ className: 'fy-question-review-row' });
    expect(rows.map(row => row.props['aria-label'])).toEqual([
      'Change answer to RWC socials',
      'Change answer to MX Weekly',
      'Change answer to Meet & Greet',
      'Change answer to Sprint plan',
    ]);
    expect(form.root.findAllByProps({ className: 'fy-question-review-a' }).map(item => item.children.join(''))).toEqual(
      ['Watch party at the office', 'Keep', 'Buddy', 'API, UI'],
    );

    run(() => form.root.findByProps({ 'aria-label': 'Change answer to Meet & Greet' }).props.onClick());
    expect(eyebrow(form)).toBe('Question 3 of 4');
    pick(form, 0);
    run(() => chip(form, 4).props.onClick());
    expect(form.root.findAllByProps({ className: 'fy-question-review-a' })[2]?.children.join('')).toBe('Team lead');
    await runAsync(async () => {
      button(form, 'Submit answers').props.onClick();
      await Promise.resolve();
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[5]).toEqual(['Watch party at the office', 'Keep', 'Team lead', 'API']);
  });

  test('cannot submit from the review page until every question is answered', () => {
    const { form, calls } = mount(FOUR);
    pick(form, 0);
    run(() => chip(form, 4).props.onClick());
    expect(button(form, 'Submit answers').props.disabled).toBe(true);
    expect(form.root.findAllByProps({ className: 'fy-question-review-a' })[1]?.children.join('')).toBe(
      'Not answered yet',
    );
    expect(form.root.findAllByProps({ className: 'fy-question-hint' })[0]?.children.join('')).toBe(
      'Answer every question to submit.',
    );
    expect(calls).toHaveLength(0);
  });

  test('keeps the answers and the step when the form is remounted, and forgets them once answered', async () => {
    const drafts = new QuestionDraftStore();
    const first = mount(FOUR, drafts);
    pick(first.form, 1);
    run(() => button(first.form, 'Next').props.onClick());
    pick(first.form, 0);
    run(() => first.form.unmount());

    const again = mount(FOUR, drafts);
    expect(eyebrow(again.form)).toBe('Question 2 of 4');
    expect(again.form.root.findAllByType('input')[0]?.props.checked).toBe(true);
    run(() => button(again.form, 'Back').props.onClick());
    expect(again.form.root.findAllByType('input')[1]?.props.checked).toBe(true);
    run(() => again.form.unmount());

    const otherDaemon = mount(FOUR, drafts, { daemon: daemonB });
    expect(eyebrow(otherDaemon.form)).toBe('Question 1 of 4');
    expect(otherDaemon.form.root.findAllByType('input').some(input => input.props.checked === true)).toBe(false);

    let answered = 0;
    const done = mount(FOUR, drafts, { answered: () => answered++ });
    pick(done.form, 0);
    run(() => button(done.form, 'Next').props.onClick());
    pick(done.form, 0);
    run(() => button(done.form, 'Next').props.onClick());
    pick(done.form, 0);
    run(() => button(done.form, 'Next').props.onClick());
    pick(done.form, 0);
    run(() => button(done.form, 'Review').props.onClick());
    await runAsync(async () => {
      button(done.form, 'Submit answers').props.onClick();
      await Promise.resolve();
    });
    expect(answered).toBe(1);
    expect(drafts.load(`daemon-a\u0000session\u0000four\u00004`)).toBeUndefined();
  });

  test('starts fresh when the form is re-pointed at another question', () => {
    const drafts = new QuestionDraftStore();
    const { form } = mount(FOUR, drafts);
    pick(form, 0);
    run(() => button(form, 'Next').props.onClick());
    run(() =>
      form.update(
        <QuestionForm
          api={{ answer: async () => undefined }}
          daemon={daemonA}
          drafts={drafts}
          question={{ ...FOUR, toolUseId: 'next-ask' }}
          sessionId="session"
        />,
      ),
    );
    expect(eyebrow(form)).toBe('Question 1 of 4');
    expect(form.root.findAllByType('input').some(input => input.props.checked === true)).toBe(false);
  });

  test('puts the reader at the new step title, not in a text field', () => {
    const { form, focused } = mount(FOUR);
    pick(form, 0);
    run(() => button(form, 'Next').props.onClick());
    expect(focused).toEqual(['legend']);
    run(() => chip(form, 4).props.onClick());
    expect(focused).toEqual(['legend', 'h3']);
  });

  test('wraps a typed Other answer in its own step and shows it on the review page', () => {
    const { form, focused } = mount(FOUR);
    run(() => form.root.findAllByType('input')[2]?.props.onChange());
    expect(focused).toContain('textarea');
    const area = form.root.findByType('textarea');
    expect(area.props['aria-label']).toBe('Other answer for question 1');
    run(() => area.props.onFocus({ currentTarget: { scrollIntoView: () => focused.push('scrolled') } }));
    expect(focused).toContain('scrolled');
    run(() => area.props.onChange({ currentTarget: { value: '  something else entirely\nover two lines ' } }));
    run(() => chip(form, 4).props.onClick());
    expect(form.root.findAllByProps({ className: 'fy-question-review-a' })[0]?.children.join('')).toBe(
      'something else entirely\nover two lines',
    );
  });

  test('Enter picks an unpicked option, and a picked one moves on', () => {
    const { form } = mount(FOUR);
    const first = () => form.root.findAllByType('input')[0] as ReactTestInstance;
    const log = enter(first());
    expect(log.prevented).toBe(1);
    expect(first().props.checked).toBe(true);
    expect(eyebrow(form)).toBe('Question 1 of 4');
    enter(first());
    expect(eyebrow(form)).toBe('Question 2 of 4');
  });

  test('Enter on Other picks it, then returns to the text field until there is text to move on with', () => {
    const { form, focused } = mount(FOUR);
    const other = () => form.root.findAllByType('input')[2] as ReactTestInstance;
    enter(other());
    expect(other().props.checked).toBe(true);
    focused.length = 0;
    enter(other());
    expect(focused).toEqual(['textarea']);
    run(() => form.root.findByType('textarea').props.onChange({ currentTarget: { value: 'words' } }));
    enter(other());
    expect(eyebrow(form)).toBe('Question 2 of 4');
  });

  test('Ctrl or Cmd+Enter in the text field moves on once there is text, and plain Enter does not', () => {
    const { form } = mount(FOUR);
    run(() => form.root.findAllByType('input')[2]?.props.onChange());
    const area = () => form.root.findByType('textarea');
    const plain = enter(area());
    expect(plain.prevented).toBe(0);
    enter(area(), { ctrlKey: true });
    expect(eyebrow(form)).toBe('Question 1 of 4');
    run(() => area().props.onChange({ currentTarget: { value: 'words' } }));
    enter(area(), { metaKey: true });
    expect(eyebrow(form)).toBe('Question 2 of 4');
  });

  test('ignores keys that are not Enter and Enter while composing text', () => {
    const { form } = mount(FOUR);
    const input = form.root.findAllByType('input')[0] as ReactTestInstance;
    run(() =>
      input.props.onKeyDown({ key: 'ArrowDown', nativeEvent: { isComposing: false }, preventDefault: () => {} }),
    );
    enter(input, { nativeEvent: { isComposing: true } });
    expect(form.root.findAllByType('input')[0]?.props.checked).toBe(false);
  });

  test('Enter on a picked answer in a single-question form submits it', async () => {
    const { form, calls } = mount({
      toolUseId: 'solo',
      questions: [{ question: 'Ship?', options: [{ label: 'Yes' }] }],
    });
    const input = () => form.root.findAllByType('input')[0] as ReactTestInstance;
    enter(input());
    expect(calls).toHaveLength(0);
    await runAsync(async () => {
      enter(input());
      await Promise.resolve();
    });
    expect(calls).toHaveLength(1);
  });

  test('un-ticking the last box of a multi-select leaves its step unanswered again', () => {
    const { form } = mount(FOUR);
    run(() => chip(form, 3).props.onClick());
    pick(form, 0);
    pick(form, 1);
    pick(form, 0);
    expect(chip(form, 3).props['data-answered']).toBe('true');
    pick(form, 1);
    expect(chip(form, 3).props['data-answered']).toBe('false');
  });

  test('stops accepting keys while an answer is being sent', async () => {
    let release: () => void = () => {};
    const form = render(
      <QuestionForm
        api={{ answer: () => new Promise(resolve => (release = () => resolve(undefined))) }}
        daemon={daemonA}
        drafts={new QuestionDraftStore()}
        question={{
          toolUseId: 'busy',
          questions: [{ question: 'Ship?', options: [{ label: 'Yes' }, { label: 'No' }] }],
        }}
        sessionId="session"
      />,
    );
    pick(form, 0);
    await runAsync(async () => {
      form.root.findByProps({ className: 'fy-question-submit' }).props.onClick();
      await Promise.resolve();
    });
    enter(form.root.findAllByType('input')[1] as ReactTestInstance);
    expect(form.root.findAllByType('input')[0]?.props.checked).toBe(true);
    expect(form.root.findAllByType('input')[1]?.props.checked).toBe(false);
    await runAsync(async () => {
      release();
      await Promise.resolve();
    });
  });
});

describe('QuestionDraftStore', () => {
  const draft = (step: number) => ({
    step,
    answers: { picks: [[]], others: [''], otherSelected: [false] },
  });

  test('returns what was saved and nothing for an unknown question', () => {
    const store = new QuestionDraftStore();
    store.save('a', draft(2));
    expect(store.load('a')?.step).toBe(2);
    expect(store.load('b')).toBeUndefined();
    store.clear('a');
    expect(store.load('a')).toBeUndefined();
  });

  test('lets the least recently saved draft go once the page holds too many', () => {
    const store = new QuestionDraftStore();
    for (let index = 0; index < 21; index += 1) store.save(`q${index}`, draft(index));
    expect(store.load('q0')).toBeUndefined();
    expect(store.load('q1')?.step).toBe(1);
    store.save('q1', draft(9));
    store.save('q21', draft(21));
    expect(store.load('q2')).toBeUndefined();
    expect(store.load('q1')?.step).toBe(9);
  });
});
