import { afterEach, describe, expect, test } from 'bun:test';
import type { AgendaItem } from '@ferretry/protocol';
import { AgendaCard } from '../../../src/features/agenda/agenda-card.tsx';
import type { InboxAction } from '../../../src/lib/agenda-inbox.ts';
import { withComposerNote } from '../../../src/lib/agenda-reply.ts';
import { agendaItem, choices } from '../../support/agenda-inbox.tsx';
import { interact, type Mounted, mount, must } from '../../support/dom.ts';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const card = async (item: AgendaItem, options: { swipeHints?: boolean } = {}) => {
  const acts: InboxAction[] = [];
  view = await mount(<AgendaCard item={item} onAct={action => acts.push(action)} {...options} />);
  return { acts, root: must(view.container, 'view') };
};

const answer = (root: ParentNode, direction: 'left' | 'up' | 'right'): HTMLButtonElement =>
  must(root.querySelector<HTMLButtonElement>(`[data-agenda-answer="${direction}"]`), `the ${direction} answer`);

const review = agendaItem('R1', { subject: 'Is the migration safe?', kind: 'review' });
const permission = agendaItem('P1', {
  subject: 'Run the deploy script?',
  ask: { kind: 'permission' },
  answers: [
    { direction: 'left', does: 'reject', label: 'Deny' },
    { direction: 'up', does: 'approve', label: 'Always allow', description: 'Stop asking for this script' },
    { direction: 'right', does: 'approve', label: 'Allow' },
  ],
});

describe('the card says what it is, at a glance', () => {
  test('draws the kind and the question as the heading, and the recommendation as a tag and a reason line', async () => {
    const item = agendaItem('A1', {
      title: 'Pick the database',
      subject: 'Which database should the board use?',
      ask: choices('SQLite', 'Postgres'),
      recommendation: { decision: 'SQLite', why: 'No server to run.' },
      context: 'The board needs somewhere to keep its tasks.',
    });
    const { root } = await card(item);
    expect(root.querySelector('[data-agenda-kind]')?.textContent).toBe('Choice');
    expect(root.querySelector('[data-agenda-title]')?.textContent).toBe('Which database should the board use?');
    expect(root.querySelector('[data-agenda-ask]')).toBeNull();
    const tagged = root.querySelector('[data-agenda-option="SQLite"] [data-agenda-recommended]');
    expect(tagged?.textContent).toContain('Recommended');
    expect(root.querySelectorAll('[data-agenda-answer] [data-agenda-recommended]')).toHaveLength(1);
    expect(root.querySelector('[data-agenda-actions] [data-agenda-recommendation]')?.textContent).toBe(
      'No server to run.',
    );
    expect(root.querySelector('[data-agenda-why]')?.textContent).toBe('Why A1 needs you.');
    expect(root.querySelector('textarea')).toBeNull();
    expect(root.textContent).not.toContain('The board needs somewhere to keep its tasks.');
  });

  test('an old item with no title is headed by its whole ask, said once', async () => {
    const subject = 'Rebase onto main now, or wait for the agenda store change to merge first?';
    const { root } = await card(agendaItem('A1', { subject }));
    expect(root.querySelector('[data-agenda-title]')?.textContent).toBe(subject);
    expect(root.querySelector('[data-agenda-ask]')).toBeNull();
  });

  test('says a lone question’s recommendation under the ask, and does not repeat the question below', async () => {
    const { root } = await card(
      agendaItem('A1', {
        title: 'Board database',
        subject: 'Which database should keep the board’s finished items?',
        ask: choices('SQLite', 'Postgres'),
        questions: [
          {
            question: 'Which database should hold the board?',
            options: [{ label: 'SQLite' }, { label: 'Postgres' }],
            recommended: 'SQLite',
            why: 'No server to run.',
          },
        ],
      }),
    );
    expect(root.querySelector('[data-agenda-recommendation]')?.textContent).toBe('No server to run.');
    expect(root.querySelector('[data-agenda-option="SQLite"] [data-agenda-recommended]')).not.toBeNull();
    expect(root.querySelector('[data-agenda-question]')).toBeNull();
    expect(root.textContent).not.toContain('Which database should hold the board?');
  });

  test('still draws several questions, each answered on the card', async () => {
    const { root } = await card(
      agendaItem('A1', {
        subject: 'Two things before the release',
        ask: { kind: 'open-question' },
        questions: [{ question: 'Which day should it ship?' }, { question: 'Who should announce it?' }],
      }),
    );
    expect(root.querySelector('[data-agenda-section="questions"]')).not.toBeNull();
    expect(root.querySelector('input[type="text"], textarea')).toBeNull();
  });

  test('draws no empty sections for an item with no detail', async () => {
    const { root } = await card(agendaItem('A1', { subject: 'Heads up', why: 'Heads up' }));
    expect(root.querySelectorAll('[data-agenda-section]')).toHaveLength(0);
    expect(root.querySelector('[data-agenda-recommendation]')).toBeNull();
  });
});

describe('the answer bar', () => {
  test('lays the answers left · up · right with an arrow each, the right one primary', async () => {
    const { root } = await card(permission, { swipeHints: true });
    const bar = [...root.querySelectorAll('[data-agenda-answer]')];
    expect(bar.map(button => button.getAttribute('data-agenda-answer'))).toEqual(['left', 'up', 'right']);
    expect(bar.map(button => button.querySelector('svg') !== null)).toEqual([true, true, true]);
    expect(answer(root, 'right').getAttribute('data-variant')).toBe('primary');
    expect(answer(root, 'left').getAttribute('data-variant')).toBeNull();
    expect(answer(root, 'up').textContent).toContain('Always allow');
  });

  test('gives an answer’s description to assistive tech', async () => {
    const { root } = await card(permission);
    const up = answer(root, 'up');
    const describedBy = up.getAttribute('aria-describedby');
    expect(describedBy).not.toBeNull();
    expect(root.ownerDocument.getElementById(describedBy ?? '')?.textContent).toBe('Stop asking for this script');
  });

  test('draws no arrows when the card does not swipe', async () => {
    const { root } = await card(permission);
    expect(answer(root, 'left').querySelector('svg')).toBeNull();
  });

  test('a card with no answers draws no answer bar', async () => {
    const { root } = await card(agendaItem('A1', { ask: { kind: 'open-question' } }));
    expect(root.querySelector('[data-agenda-answer]')).toBeNull();
  });

  test('draws an old choice’s options past the third as plain extra buttons', async () => {
    const { acts, root } = await card(agendaItem('A1', { ask: choices('One', 'Two', 'Three', 'Four', 'Five') }), {
      swipeHints: true,
    });
    expect(root.querySelectorAll('[data-agenda-answer]')).toHaveLength(3);
    const extras = [...root.querySelectorAll<HTMLButtonElement>('.fy-attn-extra')];
    expect(extras.map(button => button.textContent?.trim())).toEqual(['Four', 'Five']);
    expect(extras.every(button => button.querySelector('svg') === null)).toBe(true);
    await interact(() => must(extras[1], 'Five').click());
    expect(acts).toEqual([{ kind: 'respond', label: 'Five', response: { kind: 'multiple-choice', choice: 'Five' } }]);
  });

  test('gives an extra option’s description to assistive tech', async () => {
    const { root } = await card(
      agendaItem('A1', {
        ask: {
          kind: 'multiple-choice',
          options: [
            { label: 'One' },
            { label: 'Two' },
            { label: 'Three' },
            { label: 'Four', description: 'Keep the old flow for a week' },
          ],
        },
      }),
    );
    const extra = must(root.querySelector<HTMLButtonElement>('.fy-attn-extra'), 'the extra option');
    const described = extra.getAttribute('aria-describedby') ?? '';
    expect(described).not.toBe('');
    expect(root.querySelector(`[id="${described}"]`)?.textContent).toBe('Keep the old flow for a week');
  });

  test('sends each answer as the action it means', async () => {
    const { acts, root } = await card(permission);
    await interact(() => answer(root, 'right').click());
    expect(acts[0]).toEqual({
      kind: 'respond',
      label: 'Allow',
      response: { kind: 'permission', decision: 'approve' },
    });
    await interact(() => answer(root, 'left').click());
    expect(acts[1]).toMatchObject({ response: { kind: 'permission', decision: 'reject' } });
  });

  test('keeps Dismiss in the ⋯ menu, and drops it from there when an answer already dismisses', async () => {
    const { acts, root } = await card(permission);
    await interact(() => must(root.querySelector<HTMLButtonElement>('[data-agenda-more]'), 'more').click());
    await interact(() =>
      must(root.querySelector<HTMLButtonElement>('[role="menu"] [data-agenda-dismiss]'), 'Dismiss').click(),
    );
    expect(acts).toEqual([{ kind: 'dismiss', label: 'Dismiss' }]);
    await view?.unmount();
    const skippable = agendaItem('A2', {
      ask: { kind: 'task' },
      answers: [
        { direction: 'left', does: 'needs-info', label: 'Need more info' },
        { direction: 'up', does: 'dismiss', label: 'Skip' },
        { direction: 'right', does: 'done', label: 'Done' },
      ],
    });
    view = await mount(<AgendaCard item={skippable} onAct={() => {}} />);
    expect(view.container.querySelector('[data-agenda-more]')).toBeNull();
  });
});

describe('answering is replying', () => {
  test('the card has no reply box, note link or Other answer, whatever it asks', async () => {
    for (const item of [permission, review, agendaItem('T1', { ask: { kind: 'task' } })]) {
      const { root } = await card(item);
      expect(root.querySelector('textarea')).toBeNull();
      expect(root.querySelector('[data-agenda-reply-toggle]')).toBeNull();
      expect(root.querySelector('[data-agenda-other]')).toBeNull();
      await view?.unmount();
    }
  });

  test.each([
    ['right', { kind: 'permission', decision: 'approve' }, 'Allow'],
    ['left', { kind: 'permission', decision: 'reject' }, 'Deny'],
  ] as const)('the %s answer leaves bare; the host adds the composer text', async (direction, response, label) => {
    const { acts, root } = await card(permission);
    await interact(() => answer(root, direction).click());
    expect(acts).toEqual([{ kind: 'respond', label, response }]);
  });

  test('a task: Done resolves and Need more info asks, both bare', async () => {
    const task = await card(agendaItem('T1', { ask: { kind: 'task' } }));
    await interact(() => answer(task.root, 'right').click());
    await interact(() => answer(task.root, 'left').click());
    expect(task.acts).toEqual([
      { kind: 'resolve', label: 'Done' },
      { kind: 'needs-info', label: 'Need more info' },
    ]);
  });

  test('a review: Looks good answers; Needs changes is no button, the card says to write it in the message box', async () => {
    const { acts, root } = await card(review);
    await interact(() => answer(root, 'right').click());
    expect(acts).toEqual([
      { kind: 'respond', label: 'Looks good', response: { kind: 'answer-review', verdict: 'good' } },
    ]);
    expect(root.querySelector('[data-agenda-answer="left"]')).toBeNull();
    expect(root.querySelector('[data-agenda-composer-hint]')?.textContent).toContain('message box');
  });

  test('a ferret-worded label is the note, and the composer text joins it', async () => {
    const { acts, root } = await card(permission);
    await interact(() => answer(root, 'up').click());
    expect(acts[0]).toMatchObject({ note: 'Always allow' });
    expect(withComposerNote(acts[0] as InboxAction, 'for this repo')).toMatchObject({
      note: 'Always allow — for this repo',
    });
  });

  test('a text-only ask has no options and no send button: it says to reply in the message box', async () => {
    const { root } = await card(
      agendaItem('Q1', { subject: 'What should it be called?', ask: { kind: 'open-question' } }),
    );
    expect(root.querySelector('[data-agenda-answer]')).toBeNull();
    expect(root.querySelector('[data-agenda-send]')).toBeNull();
    expect(root.querySelector('[data-agenda-composer-hint]')?.textContent).toBe('Reply in the message box below.');
  });
});

describe('a card answered one answer per question', () => {
  test('swaps the answer bar and the reply for one Send answers button', async () => {
    const item = agendaItem('M1', {
      ask: { kind: 'open-question' },
      questions: [
        { question: 'Which engine?', options: [{ label: 'SQLite' }, { label: 'Postgres' }] },
        { question: 'Migrate when?', options: [{ label: 'Now' }, { label: 'Later' }] },
      ],
    });
    const { root } = await card(item);
    expect(root.querySelector('[data-agenda-send-answers]')).not.toBeNull();
    expect(root.querySelector('[data-agenda-answer]')).toBeNull();
    expect(root.querySelector('[data-agenda-reply-toggle]')).toBeNull();
    expect(root.querySelector('textarea, input[type="text"]')).toBeNull();
  });

  test('an open question among them is asked once, with no picker and no boilerplate about the message box', async () => {
    const item = agendaItem('M2', {
      ask: { kind: 'open-question' },
      questions: [{ question: 'Which engine?', options: [{ label: 'SQLite' }] }, { question: 'Who announces it?' }],
    });
    const { root } = await card(item);
    expect(root.querySelector('[data-agenda-composer-hint]')).toBeNull();
    expect(root.textContent).not.toContain('message box');
    expect(root.textContent?.split('Who announces it?').length).toBe(2);
    expect(root.querySelectorAll('[data-agenda-pick]')).toHaveLength(1);
  });

  test('Send answers is ready only once at least one answer is picked, then sends them together', async () => {
    const item = agendaItem('M3', {
      ask: { kind: 'open-question' },
      questions: [
        { question: 'Which engine?', options: [{ label: 'SQLite' }, { label: 'Postgres' }] },
        { question: 'Migrate when?', options: [{ label: 'Now' }, { label: 'Later' }] },
      ],
    });
    const { acts, root } = await card(item);
    const send = must(root.querySelector<HTMLButtonElement>('[data-agenda-send-answers]'), 'Send answers');
    expect(send.disabled).toBe(true);
    await interact(() => must(root.querySelector<HTMLButtonElement>('[data-agenda-pick="SQLite"]'), 'SQLite').click());
    expect(send.disabled).toBe(false);
    await interact(() => send.click());
    expect(acts).toHaveLength(1);
    expect(acts[0]?.kind).toBe('respond');
  });
});
