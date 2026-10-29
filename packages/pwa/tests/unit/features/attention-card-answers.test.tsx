import { afterEach, describe, expect, test } from 'bun:test';
import type { AttentionItem } from '@ferretry/protocol';
import { AttentionCard } from '../../../src/features/attention/attention-card.tsx';
import type { InboxAction } from '../../../src/lib/attention-inbox.ts';
import { attentionItem, choices } from '../../support/attention-inbox.tsx';
import { interact, type Mounted, mount, must } from '../../support/dom.ts';

const nativeTextarea = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const card = async (item: AttentionItem, options: { swipeHints?: boolean } = {}) => {
  const acts: InboxAction[] = [];
  view = await mount(<AttentionCard item={item} onAct={action => acts.push(action)} {...options} />);
  return { acts, root: must(view.container, 'view') };
};

const answer = (root: ParentNode, direction: 'left' | 'up' | 'right'): HTMLButtonElement =>
  must(root.querySelector<HTMLButtonElement>(`[data-attention-answer="${direction}"]`), `the ${direction} answer`);

const box = (root: ParentNode): HTMLTextAreaElement | null => root.querySelector('textarea[data-attention-reply]');

const openReply = async (root: ParentNode): Promise<HTMLTextAreaElement> => {
  await interact(() =>
    must(root.querySelector<HTMLButtonElement>('[data-attention-reply-toggle]'), 'the Reply toggle').click(),
  );
  return must(box(root), 'the reply box');
};

const type = async (field: HTMLTextAreaElement, text: string): Promise<void> => {
  await interact(() => {
    nativeTextarea?.call(field, text);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const review = attentionItem('R1', { subject: 'Is the migration safe?', kind: 'review' });
const permission = attentionItem('P1', {
  subject: 'Run the deploy script?',
  ask: { kind: 'permission' },
  answers: [
    { direction: 'left', does: 'reject', label: 'Deny' },
    { direction: 'up', does: 'approve', label: 'Always allow', description: 'Stop asking for this script' },
    { direction: 'right', does: 'approve', label: 'Allow' },
  ],
});

describe('the card says what it is, at a glance', () => {
  test('draws the kind, the title, the ask and the recommendation above the detail', async () => {
    const item = attentionItem('A1', {
      title: 'Pick the database',
      subject: 'Which database should the board use?',
      ask: choices('SQLite', 'Postgres'),
      recommendation: { decision: 'SQLite', why: 'No server to run.' },
      context: 'The board needs somewhere to keep its tasks.',
    });
    const { root } = await card(item);
    expect(root.querySelector('[data-attention-kind]')?.textContent).toBe('Choice');
    expect(root.querySelector('[data-attention-title]')?.textContent).toBe('Pick the database');
    expect(root.querySelector('[data-attention-ask]')?.textContent).toBe('Which database should the board use?');
    expect(root.querySelector('[data-attention-recommendation]')?.textContent).toContain('SQLite');
    expect(root.querySelector('[data-attention-recommendation]')?.textContent).toContain('No server to run.');
    const scroll = must(root.querySelector('[data-attention-scroll]'), 'the detail region');
    expect(scroll.textContent).toContain('The board needs somewhere to keep its tasks.');
    expect(scroll.querySelector('[data-attention-title], [data-attention-ask]')).toBeNull();
  });

  test('an old item with no title is headed by its whole ask, said once', async () => {
    const subject = 'Rebase onto main now, or wait for the attention store change to merge first?';
    const { root } = await card(attentionItem('A1', { subject }));
    expect(root.querySelector('[data-attention-title]')?.textContent).toBe(subject);
    expect(root.querySelector('[data-attention-ask]')).toBeNull();
  });

  test('says a lone question’s recommendation under the ask, and does not repeat the question below', async () => {
    const { root } = await card(
      attentionItem('A1', {
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
    expect(root.querySelector('[data-attention-recommendation]')?.textContent).toContain('SQLite — No server to run.');
    expect(root.querySelector('[data-attention-section="questions"]')).toBeNull();
    expect(root.textContent).not.toContain('Which database should hold the board?');
  });

  test('still draws several questions, each answered on the card', async () => {
    const { root } = await card(
      attentionItem('A1', {
        subject: 'Two things before the release',
        ask: { kind: 'open-question' },
        questions: [{ question: 'Which day should it ship?' }, { question: 'Who should announce it?' }],
      }),
    );
    expect(root.querySelector('[data-attention-section="questions"]')).not.toBeNull();
  });

  test('draws no empty sections for an item with no detail', async () => {
    const { root } = await card(attentionItem('A1', { subject: 'Heads up' }));
    expect(root.querySelectorAll('[data-attention-section]')).toHaveLength(0);
    expect(root.querySelector('[data-attention-recommendation]')).toBeNull();
  });
});

describe('the answer bar', () => {
  test('lays the answers left · up · right with an arrow each, the right one primary', async () => {
    const { root } = await card(permission, { swipeHints: true });
    const bar = [...root.querySelectorAll('[data-attention-answer]')];
    expect(bar.map(button => button.getAttribute('data-attention-answer'))).toEqual(['left', 'up', 'right']);
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
    const { root } = await card(attentionItem('A1', { ask: { kind: 'open-question' } }));
    expect(root.querySelector('[data-attention-answer]')).toBeNull();
  });

  test('draws an old choice’s options past the third as plain extra buttons', async () => {
    const { acts, root } = await card(attentionItem('A1', { ask: choices('One', 'Two', 'Three', 'Four', 'Five') }), {
      swipeHints: true,
    });
    expect(root.querySelectorAll('[data-attention-answer]')).toHaveLength(3);
    const extras = [...root.querySelectorAll<HTMLButtonElement>('.fy-attn-extra')];
    expect(extras.map(button => button.textContent?.trim())).toEqual(['Four', 'Five']);
    expect(extras.every(button => button.querySelector('svg') === null)).toBe(true);
    await interact(() => must(extras[1], 'Five').click());
    expect(acts).toEqual([{ kind: 'respond', label: 'Five', response: { kind: 'multiple-choice', choice: 'Five' } }]);
  });

  test('gives an extra option’s description to assistive tech', async () => {
    const { root } = await card(
      attentionItem('A1', {
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
    await interact(() => must(root.querySelector<HTMLButtonElement>('[data-attention-more]'), 'more').click());
    await interact(() =>
      must(root.querySelector<HTMLButtonElement>('[role="menu"] [data-attention-dismiss]'), 'Dismiss').click(),
    );
    expect(acts).toEqual([{ kind: 'dismiss', label: 'Dismiss' }]);
    await view?.unmount();
    const skippable = attentionItem('A2', {
      ask: { kind: 'task' },
      answers: [
        { direction: 'left', does: 'needs-info', label: 'Need more info' },
        { direction: 'up', does: 'dismiss', label: 'Skip' },
        { direction: 'right', does: 'done', label: 'Done' },
      ],
    });
    view = await mount(<AttentionCard item={skippable} onAct={() => {}} />);
    expect(view.container.querySelector('[data-attention-more]')).toBeNull();
  });
});

describe('the optional reply', () => {
  test('is collapsed on an ordinary card, and opens from "Reply…"', async () => {
    const { root } = await card(permission);
    expect(box(root)).toBeNull();
    const toggle = must(root.querySelector('[data-attention-reply-toggle]'), 'toggle');
    expect(toggle.textContent).toContain('Reply…');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    const field = await openReply(root);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(field);
  });

  test.each([
    ['right', 'approve', { kind: 'permission', decision: 'approve' }],
    ['left', 'reject', { kind: 'permission', decision: 'reject' }],
  ] as const)('rides along as the note of the %s answer (%s)', async (direction, _does, response) => {
    const { acts, root } = await card(permission);
    await type(await openReply(root), 'only for staging');
    await interact(() => answer(root, direction).click());
    expect(acts).toEqual([
      { kind: 'respond', label: direction === 'right' ? 'Allow' : 'Deny', response, note: 'only for staging' },
    ]);
    expect(box(root)?.value).toBe('');
  });

  test('rides along with a resolve, a good verdict and a needs-info', async () => {
    const task = await card(attentionItem('T1', { ask: { kind: 'task' } }));
    await type(await openReply(task.root), 'done at noon');
    await interact(() => answer(task.root, 'right').click());
    expect(task.acts).toEqual([{ kind: 'resolve', label: 'Done', note: 'done at noon' }]);
    await view?.unmount();

    const good = await card(review);
    await type(await openReply(good.root), 'nice work');
    await interact(() => answer(good.root, 'right').click());
    expect(good.acts).toEqual([
      { kind: 'respond', label: 'Looks good', response: { kind: 'answer-review', verdict: 'good' }, note: 'nice work' },
    ]);
    await view?.unmount();

    const ask = await card(attentionItem('T2', { ask: { kind: 'task' } }));
    await type(await openReply(ask.root), 'which environment?');
    await interact(() => answer(ask.root, 'left').click());
    expect(ask.acts).toEqual([{ kind: 'needs-info', label: 'Need more info', note: 'which environment?' }]);
  });

  test('a ferret-worded label leads the note', async () => {
    const { acts, root } = await card(permission);
    await type(await openReply(root), 'for this repo');
    await interact(() => answer(root, 'up').click());
    expect(acts).toEqual([
      {
        kind: 'respond',
        label: 'Always allow',
        response: { kind: 'permission', decision: 'approve' },
        note: 'Always allow — for this repo',
      },
    ]);
  });

  test('a ferret-worded label is the note when nothing was typed', async () => {
    const { acts, root } = await card(permission);
    await interact(() => answer(root, 'up').click());
    expect(acts[0]).toMatchObject({ note: 'Always allow' });
  });

  test('says "Reply added" once there is text, even when the box is shut', async () => {
    const { root } = await card(permission);
    await type(await openReply(root), 'hello');
    await interact(() =>
      must(root.querySelector<HTMLButtonElement>('[data-attention-reply-toggle]'), 'toggle').click(),
    );
    expect(box(root)).toBeNull();
    expect(root.querySelector('[data-attention-reply-toggle]')?.textContent).toContain('Reply added');
  });

  test('"Needs changes" with an empty box opens and focuses the box instead of sending', async () => {
    const { acts, root } = await card(review);
    expect(box(root)).toBeNull();
    await interact(() => answer(root, 'left').click());
    expect(acts).toEqual([]);
    const field = must(box(root), 'the reply box');
    expect(document.activeElement).toBe(field);
    await type(field, 'rename the flag');
    await interact(() => answer(root, 'left').click());
    expect(acts).toEqual([
      {
        kind: 'respond',
        label: 'Needs changes',
        response: { kind: 'answer-review', verdict: 'clarify', clarification: 'rename the flag' },
      },
    ]);
  });

  test('"Needs changes" with the box already open and empty focuses it again', async () => {
    const { acts, root } = await card(review);
    const field = await openReply(root);
    must(root.querySelector<HTMLButtonElement>('[data-attention-reply-toggle]'), 'the Reply toggle').focus();
    expect(document.activeElement).not.toBe(field);
    await interact(() => answer(root, 'left').click());
    expect(acts).toEqual([]);
    expect(document.activeElement).toBe(field);
  });

  test('a card that is only a question has the box open with a Send button, and sends the text as the answer', async () => {
    const { acts, root } = await card(
      attentionItem('Q1', { subject: 'What should it be called?', ask: { kind: 'open-question' } }),
    );
    const field = must(box(root), 'the open reply box');
    expect(root.querySelector('[data-attention-reply-toggle]')).toBeNull();
    const send = must(root.querySelector<HTMLButtonElement>('[data-attention-send]'), 'Send');
    expect(send.disabled).toBe(true);
    await type(field, 'Ferretry');
    expect(send.disabled).toBe(false);
    await interact(() => send.click());
    expect(acts).toEqual([
      { kind: 'respond', label: 'Reply', response: { kind: 'open-question', answer: 'Ferretry' } },
    ]);
    expect(box(root)?.value).toBe('');
  });
});

describe('a card answered one answer per question', () => {
  test('swaps the answer bar and the reply for one Send answers button', async () => {
    const item = attentionItem('M1', {
      ask: { kind: 'open-question' },
      questions: [
        { question: 'Which engine?', options: [{ label: 'SQLite' }, { label: 'Postgres' }] },
        { question: 'Migrate when?', options: [{ label: 'Now' }, { label: 'Later' }] },
      ],
    });
    const { root } = await card(item);
    expect(root.querySelector('[data-attention-send-answers]')).not.toBeNull();
    expect(root.querySelector('[data-attention-answer]')).toBeNull();
    expect(root.querySelector('[data-attention-reply-toggle]')).toBeNull();
  });
});
