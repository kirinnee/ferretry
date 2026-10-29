import { describe, expect, it } from 'bun:test';
import type { AttentionItem } from '@ferretry/protocol';
import {
  answerAction,
  answerActions,
  answerNote,
  canDiscussNow,
  cardAnswers,
  discussAction,
  hasCustomLabel,
  isTextOnlyAsk,
  kindWord,
  needsReplyText,
  swipeTargets,
} from '../../src/lib/attention-answers.ts';
import { swipeMap } from '../../src/lib/attention-inbox.ts';
import { attentionItem, choices } from '../support/attention-inbox.tsx';

const withAnswers = (answers: AttentionItem['answers'], overrides: Partial<AttentionItem> = {}): AttentionItem =>
  attentionItem('A1', { subject: 'Ship it?', answers, ...overrides });

describe('answerAction: each effect as the action the daemon is asked to take', () => {
  it('maps every effect, carrying the reply as the note', () => {
    const answer = (does: Parameters<typeof answerAction>[0]['does'], label: string) =>
      answerAction({ direction: 'right', does, label }, 'because');
    expect(answer('choose', 'Postgres')).toEqual({
      kind: 'respond',
      label: 'Postgres',
      response: { kind: 'multiple-choice', choice: 'Postgres' },
      note: 'because',
    });
    expect(answer('approve', 'Allow')).toEqual({
      kind: 'respond',
      label: 'Allow',
      response: { kind: 'permission', decision: 'approve' },
      note: 'because',
    });
    expect(answer('reject', 'Deny')).toEqual({
      kind: 'respond',
      label: 'Deny',
      response: { kind: 'permission', decision: 'reject' },
      note: 'because',
    });
    expect(answer('good', 'Looks good')).toEqual({
      kind: 'respond',
      label: 'Looks good',
      response: { kind: 'answer-review', verdict: 'good' },
      note: 'because',
    });
    expect(answer('clarify', 'Needs changes')).toEqual({
      kind: 'respond',
      label: 'Needs changes',
      response: { kind: 'answer-review', verdict: 'clarify', clarification: 'because' },
    });
    expect(answer('done', 'Done')).toEqual({ kind: 'resolve', label: 'Done', note: 'because' });
    expect(answer('needs-info', 'Need more info')).toEqual({
      kind: 'needs-info',
      label: 'Need more info',
      note: 'because',
    });
    expect(answer('dismiss', 'Skip')).toEqual({ kind: 'dismiss', label: 'Skip', note: 'because' });
  });

  it('sends no note at all when nothing was typed', () => {
    expect(answerAction({ direction: 'right', does: 'done', label: 'Done' }, '')).toEqual({
      kind: 'resolve',
      label: 'Done',
    });
    expect(answerAction({ direction: 'right', does: 'done', label: 'Done' }, '   ')).toEqual({
      kind: 'resolve',
      label: 'Done',
    });
  });

  it('leads the note with a label the ferret worded itself', () => {
    expect(answerAction({ direction: 'up', does: 'approve', label: 'Always allow' }, 'for this repo')).toEqual({
      kind: 'respond',
      label: 'Always allow',
      response: { kind: 'permission', decision: 'approve' },
      note: 'Always allow — for this repo',
    });
    expect(answerAction({ direction: 'up', does: 'approve', label: 'Always allow' }, '')).toMatchObject({
      note: 'Always allow',
    });
  });

  it('treats the default word, and the info card’s Got it, as no custom label', () => {
    expect(hasCustomLabel({ does: 'approve', label: 'Allow' })).toBe(false);
    expect(hasCustomLabel({ does: 'approve', label: ' allow ' })).toBe(false);
    expect(hasCustomLabel({ does: 'done', label: 'Got it' })).toBe(false);
    expect(hasCustomLabel({ does: 'approve', label: 'Always allow' })).toBe(true);
    expect(hasCustomLabel({ does: 'choose', label: 'Anything' })).toBe(false);
    expect(answerNote({ does: 'choose', label: 'Postgres' }, '')).toBeUndefined();
  });
});

describe('clarify is the one answer that cannot be sent empty', () => {
  it('is not an action until the box holds text, and then sends the text as the clarification', () => {
    const clarify = { direction: 'left', does: 'clarify', label: 'Needs changes' } as const;
    expect(needsReplyText(clarify)).toBe(true);
    expect(needsReplyText({ does: 'good' })).toBe(false);
    expect(answerAction(clarify, '')).toBeNull();
    expect(answerAction(clarify, '  ')).toBeNull();
    expect(answerAction(clarify, 'rename the flag')).toEqual({
      kind: 'respond',
      label: 'Needs changes',
      response: { kind: 'answer-review', verdict: 'clarify', clarification: 'rename the flag' },
    });
  });

  it('keeps a ferret-worded clarify label in the clarification', () => {
    expect(answerAction({ direction: 'left', does: 'clarify', label: 'Not yet' }, 'tests first')).toMatchObject({
      response: { verdict: 'clarify', clarification: 'Not yet — tests first' },
    });
  });
});

describe('the swipe map is built from the card’s answers', () => {
  it('reads each kind’s default answers left · up · right', () => {
    const labels = (item: AttentionItem) =>
      Object.fromEntries(Object.entries(swipeTargets(item)).map(([direction, target]) => [direction, target?.label]));
    expect(labels(attentionItem('A1', { ask: { kind: 'task' } }))).toEqual({
      left: 'Need more info',
      right: 'Done',
      down: 'Discuss',
    });
    expect(labels(attentionItem('A2', { kind: 'yesno' }))).toEqual({ left: 'No', right: 'Yes', down: 'Discuss' });
    expect(labels(attentionItem('A3', { ask: { kind: 'permission' } }))).toEqual({
      left: 'Deny',
      right: 'Allow',
      down: 'Discuss',
    });
    expect(labels(attentionItem('A4', { kind: 'review' }))).toEqual({
      left: 'Needs changes',
      right: 'Looks good',
      down: 'Discuss',
    });
    expect(labels(attentionItem('A5'))).toEqual({ right: 'Got it', down: 'Discuss' });
  });

  it('always adds Discuss down on a ferret-raised card, never in one of the three answer slots', () => {
    const item = attentionItem('A1', { ask: choices('One', 'Two', 'Three') });
    const targets = swipeTargets(item, 'why this?');
    expect(Object.keys(targets).sort()).toEqual(['down', 'left', 'right', 'up']);
    expect(targets.down).toEqual({
      label: 'Discuss',
      action: { kind: 'discuss', label: 'Discuss', note: 'why this?' },
    });
    expect(targets.down?.answer).toBeUndefined();
    expect(swipeMap(item).down).toEqual({ kind: 'discuss', label: 'Discuss' });
  });

  it('hides Discuss on an item no ferret raised, and once the item is already in discussion', () => {
    const human = attentionItem('A1', { raisedBy: 'human', raisedBySession: null, raisedByName: null } as never);
    expect(canDiscussNow(human)).toBe(false);
    expect(swipeTargets(human).down).toBeUndefined();
    const inDiscussion = attentionItem('A2', {
      waitingOn: 'ferret',
      askedAt: '2026-07-31T10:42:00.000Z',
      waitingFor: 'discussion',
    });
    expect(canDiscussNow(inDiscussion)).toBe(false);
    expect(swipeTargets(inDiscussion).down).toBeUndefined();
    expect(canDiscussNow(attentionItem('A3'))).toBe(true);
    expect(canDiscussNow({ kind: 'info' } as never)).toBe(false);
  });

  it('sends the discuss note trimmed, and none when the reply is blank', () => {
    expect(discussAction('  hmm  ')).toEqual({ kind: 'discuss', label: 'Discuss', note: 'hmm' });
    expect(discussAction('   ')).toEqual({ kind: 'discuss', label: 'Discuss' });
  });

  it('gives a choice its recommended option on the right, then up, then left', () => {
    const item = attentionItem('A1', {
      ask: choices('Alpha', 'Beta', 'Gamma'),
      questions: [
        {
          question: 'Which?',
          options: [{ label: 'Alpha' }, { label: 'Beta' }, { label: 'Gamma' }],
          recommended: 'Beta',
        },
      ],
    });
    const targets = swipeTargets(item);
    expect(targets.right?.label).toBe('Beta');
    expect([targets.up?.label, targets.left?.label].sort()).toEqual(['Alpha', 'Gamma']);
  });

  it('gives a card with no answers no swipe at all, so no direction ever commits', () => {
    const reply = attentionItem('A1', { ask: { kind: 'open-question' } });
    expect(Object.keys(swipeTargets(reply))).toEqual(['down']);
    expect(Object.keys(swipeMap(reply))).toEqual(['down']);
    expect(answerActions(reply)).toEqual([]);
  });

  it('gives exactly the answers the ferret wrote, leaving the other directions empty', () => {
    const item = withAnswers([{ direction: 'up', does: 'dismiss', label: 'Skip' }], { ask: { kind: 'task' } });
    expect(Object.keys(swipeMap(item))).toEqual(['up', 'down']);
    const only = withAnswers([{ direction: 'right', does: 'approve', label: 'Allow' }], { kind: 'info' });
    expect(swipeMap(only).left).toBeUndefined();
    expect(swipeMap(only).up).toBeUndefined();
  });

  it('keeps a clarify swipe out of the map until the box holds text, but still targets it', () => {
    const item = attentionItem('A1', { kind: 'review' });
    expect(swipeTargets(item).left?.action).toBeNull();
    expect(swipeMap(item).left).toBeUndefined();
    expect(swipeTargets(item, 'rename it').left?.action).toMatchObject({
      response: { verdict: 'clarify', clarification: 'rename it' },
    });
    expect(swipeMap(item, 'rename it').left).toBeDefined();
  });

  it('carries the reply as the note on every sendable swipe', () => {
    const item = attentionItem('A1', { ask: { kind: 'permission' } });
    expect(swipeMap(item, 'only /tmp')).toEqual({
      down: { kind: 'discuss', label: 'Discuss', note: 'only /tmp' },
      left: {
        kind: 'respond',
        label: 'Deny',
        response: { kind: 'permission', decision: 'reject' },
        note: 'only /tmp',
      },
      right: {
        kind: 'respond',
        label: 'Allow',
        response: { kind: 'permission', decision: 'approve' },
        note: 'only /tmp',
      },
    });
  });

  it('waiting on its ferret, a to-do offers neither Done nor Need more info', () => {
    const waiting = attentionItem('A1', {
      ask: { kind: 'task' },
      waitingOn: 'ferret',
      askedAt: '2026-07-31T10:42:00.000Z',
    });
    expect(cardAnswers(waiting)).toEqual([]);
    const skippable = { ...waiting, answers: [{ direction: 'up', does: 'dismiss', label: 'Skip' }] } as AttentionItem;
    expect(cardAnswers(skippable).map(answer => answer.does)).toEqual(['dismiss']);
  });
});

describe('an old item migrates to the same controls', () => {
  it('turns an old three-way choice into three swipes and no extra buttons', () => {
    const old = attentionItem('A1', { ask: choices('One', 'Two', 'Three') });
    expect(Object.keys(swipeTargets(old)).sort()).toEqual(['down', 'left', 'right', 'up']);
    expect(answerActions(old)).toHaveLength(3);
  });

  it('turns an old two-option choice into left and right only', () => {
    const old = attentionItem('A1', { ask: choices('Yes', 'No') });
    expect(Object.keys(swipeTargets(old)).sort()).toEqual(['down', 'left', 'right']);
  });

  it('keeps options past the third as extra buttons, sent as choices and never swiped', () => {
    const old = attentionItem('A1', { ask: choices('One', 'Two', 'Three', 'Four', 'Five') });
    expect(Object.keys(swipeTargets(old)).sort()).toEqual(['down', 'left', 'right', 'up']);
    const actions = answerActions(old, 'note');
    expect(actions).toHaveLength(5);
    expect(actions.slice(3)).toEqual([
      { kind: 'respond', label: 'Four', response: { kind: 'multiple-choice', choice: 'Four' }, note: 'note' },
      { kind: 'respond', label: 'Five', response: { kind: 'multiple-choice', choice: 'Five' }, note: 'note' },
    ]);
  });

  it('reads an old permission ask as Deny / Allow', () => {
    const old = attentionItem('A1', { ask: { kind: 'permission' } });
    expect(cardAnswers(old).map(answer => [answer.direction, answer.does])).toEqual([
      ['left', 'reject'],
      ['right', 'approve'],
    ]);
  });
});

describe('the card’s kind', () => {
  it('names each kind in the word its header says', () => {
    expect(kindWord({ ask: { kind: 'task' } })).toBe('Task');
    expect(kindWord({ kind: 'yesno' })).toBe('Yes / no');
    expect(kindWord({ ask: { kind: 'permission' } })).toBe('Permission');
    expect(kindWord({ ask: choices('A', 'B') })).toBe('Choice');
    expect(kindWord({ kind: 'review' })).toBe('Review');
    expect(kindWord({})).toBe('Info');
    expect(kindWord({ ask: { kind: 'open-question' } })).toBe('Reply');
  });

  it('calls a text-only ask one only while it has no answers to give', () => {
    expect(isTextOnlyAsk(attentionItem('A1', { ask: { kind: 'open-question' } }))).toBe(true);
    expect(
      isTextOnlyAsk(
        withAnswers([{ direction: 'right', does: 'done', label: 'Done' }], { ask: { kind: 'open-question' } }),
      ),
    ).toBe(false);
    expect(isTextOnlyAsk(attentionItem('A2', { ask: { kind: 'task' } }))).toBe(false);
  });
});
