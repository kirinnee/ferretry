import { describe, expect, test } from 'bun:test';
import { type AgendaItem, gateAnswers, gateAskOptions } from '../../../app/wire/index.ts';
import { swipeTargets } from '../../../app/lib/agenda-answers.ts';
import { cardModel } from '../../../app/lib/agenda-card-model.ts';
import {
  attachedGateLead,
  attachedGateView,
  gateAnswerAction,
  gateAsksWords,
  gateWhySubject,
  gateWordsFor,
  isGateItem,
  toGateAction,
} from '../../../app/lib/gate-items.ts';
import { agendaItem, choices } from '../../support/app/agenda-inbox.tsx';

const gate = (labels: readonly [string, 'next' | 'lane' | 'reopen-with-agenda' | 'close'][], cardId = 'F1') =>
  ({
    cardId,
    laneId: 'tested',
    laneName: 'Try it',
    entry: 1,
    projectId: 'p1',
    projectName: 'Ferretry',
    options: labels.map(([label, outcome], index) => ({ id: `o${index}`, label, outcome })),
  }) as const;

const gateItem = (g: ReturnType<typeof gate>, extra: Partial<AgendaItem> = {}): AgendaItem =>
  agendaItem('G1', {
    subject: 'Pairing QR',
    kind: 'choice',
    raisedBy: 'daemon',
    // The daemon lays the options out as the protocol does: ← Not good, → Done.
    ask: { kind: 'multiple-choice', options: gateAskOptions(g) },
    gate: g,
    answers: gateAnswers(g),
    ...extra,
  } as never);

const twoOptions = gate([
  ['Done', 'close'],
  ['Not good', 'reopen-with-agenda'],
]);

describe('a gate item answers as a plain multiple choice', () => {
  test('→ is the forward option and sends the choice, nothing else', () => {
    const targets = swipeTargets(gateItem(twoOptions));
    expect(targets.left?.label).toBe('Not good');
    expect(targets.right?.action).toEqual({
      kind: 'respond',
      label: 'Done',
      response: { kind: 'multiple-choice', choice: 'Done' },
    });
  });

  test('← is Not good, and it carries the words as the note', () => {
    expect(swipeTargets(gateItem(twoOptions), 'The QR is blank').left?.action).toEqual({
      kind: 'respond',
      label: 'Not good',
      response: { kind: 'multiple-choice', choice: 'Not good' },
      note: 'The QR is blank',
    });
  });

  test('gateAnswerAction carries files only when there are some', () => {
    const attachments = { from: 'sess-g', ids: [`att_${'a'.repeat(64)}`] };
    expect(gateAnswerAction('Not good', 'blank', false, attachments)).toMatchObject({ attachments });
    expect(gateAnswerAction('Not good', 'blank')).not.toHaveProperty('attachments');
  });

  test('an answer from an attached gate names the ask it was drawn for', () => {
    const asked = gate([['Done', 'close']]);
    expect(gateAnswerAction('Done', '', asked)).toMatchObject({ gate: true, cardAsk: 'gate:F1:tested:1' });
    expect(gateAnswerAction('Done', '', true)).not.toHaveProperty('cardAsk');
    expect(toGateAction(gateAnswerAction('Done', ''), asked)).toMatchObject({
      gate: true,
      cardAsk: 'gate:F1:tested:1',
    });
    expect(toGateAction({ kind: 'dismiss', label: 'Not needed' }, asked)).toEqual({
      kind: 'dismiss',
      label: 'Not needed',
    });
  });

  test('gateAnswerAction builds the same action from the label and the words', () => {
    expect(gateAnswerAction('Not good', '  blank  ')).toEqual({
      kind: 'respond',
      label: 'Not good',
      response: { kind: 'multiple-choice', choice: 'Not good' },
      note: 'blank',
    });
    expect(gateAnswerAction('Done', '   ')).toEqual({
      kind: 'respond',
      label: 'Done',
      response: { kind: 'multiple-choice', choice: 'Done' },
    });
  });
});

describe('which answers wait for words', () => {
  const item = gateItem(twoOptions);
  const send = (label: string, note?: string) => ({ ...gateAnswerAction(label, note ?? '') });

  test('Not good needs words: held without them, sent with them', () => {
    expect(gateWordsFor(item, send('Not good'))).toBe('required');
  });

  test('the forward option needs none', () => {
    expect(gateWordsFor(item, send('Done'))).toBe('none');
  });

  test('Not yet, an ask option outside gate.options, takes words but never needs them', () => {
    const one = gateItem(gate([['OK to build', 'lane']]), {
      answers: [
        { direction: 'left', does: 'choose', label: 'OK to build' },
        { direction: 'right', does: 'choose', label: 'Not yet' },
      ],
    } as Partial<AgendaItem>);
    expect(gateWordsFor(one, send('Not yet'))).toBe('optional');
    expect(gateWordsFor(one, send('OK to build'))).toBe('none');
  });

  test('opens the words box for an answer that takes words and carries none yet', () => {
    expect(gateAsksWords(item, send('Not good'))).toBe(true);
    expect(gateAsksWords(item, send('Not good', 'blank'))).toBe(false);
    expect(gateAsksWords(item, send('Done'))).toBe(false);
  });

  test('an item without a gate holds nothing', () => {
    const plain = agendaItem('A1');
    expect(isGateItem(plain)).toBe(false);
    expect(gateWordsFor(plain, send('Not good'))).toBe('none');
  });
});

describe('a gate attached to a thread', () => {
  const thread = agendaItem('A2', {
    subject: 'Which colour?',
    waitingOn: 'ferret',
    cardAsks: [{ gate: twoOptions }] as never,
  } as Partial<AgendaItem>);

  test('is drawn as the gate item it would be, answers in the gate directions', () => {
    const view = attachedGateView(thread);
    expect(view?.gate).toEqual(twoOptions);
    expect(view?.waitingOn).toBeUndefined();
    expect(view?.ask).toEqual({
      kind: 'multiple-choice',
      options: [{ label: 'Not good' }, { label: 'Done' }],
    });
    const labels = Object.values(swipeTargets(view as AgendaItem)).map(target => target.label);
    expect(labels.sort()).toEqual(['Done', 'Not good']);
  });

  test('leads with the card title: ready to test when its options reopen it, else the lane', () => {
    expect(attachedGateLead({ ...twoOptions, cardTitle: 'Badge colour' })).toBe('Badge colour is ready to test.');
    expect(attachedGateLead(twoOptions)).toBe('It is ready to test.');
    const review = { ...twoOptions, laneName: 'Review', options: [{ ...twoOptions.options[0], outcome: 'advance' }] };
    expect(attachedGateLead({ ...review, cardTitle: 'Badge colour' } as never)).toBe('Badge colour is at Review.');
    expect(attachedGateLead(review as never)).toBe('It is at Review.');
  });

  // &B156: !A304 was a reply with three questions carrying "OK to build" for &F923, and drew no button for it.
  test('keeps none of the thread’s own answer shape, so a thread of questions, steps or a form still offers the card’s options', () => {
    const plan = gate([['OK to build', 'next']], 'F923');
    const hosts: Partial<AgendaItem>[] = [
      {
        kind: 'reply',
        ask: { kind: 'open-question' },
        questions: [{ question: 'a' }, { question: 'b' }, { question: 'c' }],
      },
      { kind: 'task', ask: { kind: 'task' } as never, steps: ['Open it', 'Rotate it'], stepsDone: [0] },
      { kind: 'form', ask: { kind: 'open-question' }, fields: [{ id: '1', type: 'text', question: 'Why?' }] as never },
      {
        kind: 'choice',
        ask: choices('Red', 'Blue'),
        optionDetails: [{ label: 'Red', detail: 'warm' }],
        recommendation: { decision: 'Red', why: 'warm' },
      } as Partial<AgendaItem>,
    ];
    for (const host of hosts) {
      const view = attachedGateView(
        agendaItem('A304', { ...host, cardAsks: [{ gate: plan }] as never } as Partial<AgendaItem>),
      );
      expect(view?.questions).toBeUndefined();
      expect(view?.steps).toBeUndefined();
      expect(view?.fields).toBeUndefined();
      expect(view?.recommendation).toBeUndefined();
      // A one-option gate offers "Not yet" beside it, as on every gate surface.
      expect(cardModel(view as AgendaItem).answers.map(answer => answer.label)).toEqual(['Not yet', 'OK to build']);
    }
  });

  test('is nothing for an item with no attachment, a gate item or a notice', () => {
    expect(attachedGateView(agendaItem('A1'))).toBeUndefined();
    expect(
      attachedGateView(gateItem(twoOptions, { cardAsks: [{ gate: twoOptions }] as never } as Partial<AgendaItem>)),
    ).toBeUndefined();
    expect(attachedGateView({ ...thread, notice: true })).toBeUndefined();
  });

  test('marks a choice for the gate and leaves every other answer alone', () => {
    expect(toGateAction(gateAnswerAction('Done', ''))).toEqual({
      ...gateAnswerAction('Done', ''),
      gate: true,
    } as never);
    expect(toGateAction({ kind: 'dismiss', label: 'Not needed' })).toEqual({ kind: 'dismiss', label: 'Not needed' });
  });

  test('Not good on the attached gate waits for words; the same label on the thread does not', () => {
    const marked = gateAnswerAction('Not good', '', true);
    expect(marked).toMatchObject({ gate: true });
    expect(gateWordsFor(thread, marked)).toBe('required');
    expect(gateAsksWords(thread, marked)).toBe(true);
    expect(gateWordsFor(thread, gateAnswerAction('Not good', ''))).toBe('none');
    expect(gateWordsFor(thread, gateAnswerAction('Done', '', true))).toBe('none');
  });
});

describe('each swipe on a real gate item means what the protocol says', () => {
  const labelsOf = (item: AgendaItem) =>
    Object.fromEntries(Object.entries(swipeTargets(item)).map(([direction, target]) => [direction, target?.label]));

  test('two options: ← Not good, → Done, whichever order the lane lists them in', () => {
    const reversed = gate([
      ['Not good', 'reopen-with-agenda'],
      ['Done', 'close'],
    ]);
    expect(labelsOf(gateItem(twoOptions))).toEqual({ left: 'Not good', right: 'Done' });
    expect(labelsOf(gateItem(reversed))).toEqual({ left: 'Not good', right: 'Done' });
  });

  test('→ sends Done and ← sends Not good with its words, never the other way round', () => {
    const item = gateItem(twoOptions);
    expect(swipeTargets(item, 'blank').right?.action).toEqual({
      kind: 'respond',
      label: 'Done',
      response: { kind: 'multiple-choice', choice: 'Done' },
      note: 'blank',
    });
    expect(swipeTargets(item, 'blank').left?.action).toEqual({
      kind: 'respond',
      label: 'Not good',
      response: { kind: 'multiple-choice', choice: 'Not good' },
      note: 'blank',
    });
  });

  test('three options: ← Not good, ↑ the third, → Done', () => {
    const three = gate([
      ['Done', 'close'],
      ['Ship later', 'lane'],
      ['Not good', 'reopen-with-agenda'],
    ]);
    expect(labelsOf(gateItem(three))).toEqual({ left: 'Not good', up: 'Ship later', right: 'Done' });
  });

  test('one option: ← Not yet, → the option', () => {
    expect(labelsOf(gateItem(gate([['OK to build', 'next']])))).toEqual({ left: 'Not yet', right: 'OK to build' });
  });

  test('every direction a gate item offers is the protocol layout, answer for answer', () => {
    for (const g of [
      twoOptions,
      gate([
        ['Done', 'close'],
        ['Ship later', 'lane'],
        ['Not good', 'reopen-with-agenda'],
      ]),
    ]) {
      const item = gateItem(g);
      expect(labelsOf(item)).toEqual(
        Object.fromEntries(gateAnswers(g).map(answer => [answer.direction, answer.label])),
      );
    }
  });
});

describe('the Not good box names the CARD being tried, never the agenda question', () => {
  const notGood = {
    kind: 'respond',
    label: 'Not good',
    response: { kind: 'multiple-choice', choice: 'Not good' },
    gate: true,
  } as const;
  const question = (extra: Partial<AgendaItem>): AgendaItem =>
    agendaItem('A9', {
      subject: 'Which colour should the unread badge be, blue or green?',
      kind: 'choice',
      ...extra,
    } as Partial<AgendaItem>);

  test('a card ask on a question thread is named by its card title and id', () => {
    const asked = {
      ...gate(
        [
          ['Done', 'close'],
          ['Not good', 'reopen-with-agenda'],
        ],
        'F61',
      ),
      cardTitle: 'Pairing a second phone',
    };
    const item = question({ cardAsks: [{ gate: asked }] as never });
    expect(gateWhySubject(item, notGood)).toBe('Pairing a second phone (&F61)');
  });

  test('the answer names WHICH card ask: the second card is named, not the first', () => {
    const first = {
      ...gate(
        [
          ['Done', 'close'],
          ['Not good', 'reopen-with-agenda'],
        ],
        'F61',
      ),
      cardTitle: 'Pairing a second phone',
    };
    const second = {
      ...gate(
        [
          ['Done', 'close'],
          ['Not good', 'reopen-with-agenda'],
        ],
        'F62',
      ),
      cardTitle: 'Badge colour',
    };
    const item = question({
      cardAsks: [
        { gate: first, at: '2026-11-03T10:00:00.000Z' },
        { gate: second, at: '2026-11-03T10:05:00.000Z' },
      ],
    } as Partial<AgendaItem>);
    expect(gateWhySubject(item, toGateAction(notGood, second))).toBe('Badge colour (&F62)');
  });

  test('a gate item is named by its own title and card', () => {
    const item = gateItem(twoOptions, { title: 'Pairing QR' });
    const plain = {
      kind: 'respond',
      label: 'Not good',
      response: { kind: 'multiple-choice', choice: 'Not good' },
    } as const;
    expect(gateWhySubject(item, plain)).toBe('Pairing QR (&F1)');
  });

  test('a card with no known title is named by its id alone', () => {
    const item = question({ cardAsks: [{ gate: gate([['Not good', 'reopen-with-agenda']], 'F7') }] as never });
    expect(gateWhySubject(item, notGood)).toBe('&F7');
  });

  test('with no card, the subject is used without its closing "?" so the heading never ends in two', () => {
    const plain = {
      kind: 'respond',
      label: 'Not yet',
      response: { kind: 'multiple-choice', choice: 'Not yet' },
    } as const;
    expect(gateWhySubject(question({}), plain)).toBe('Which colour should the unread badge be, blue or green');
  });
});
