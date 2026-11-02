import { describe, expect, test } from 'bun:test';
import { gateAnswers, gateAskOptions, type AgendaItem } from '@ferretry/protocol';
import { swipeTargets } from '../../src/lib/agenda-answers.ts';
import type { DaemonId } from '../../src/lib/daemon-connection.ts';
import {
  attachedGateLead,
  attachedGateView,
  gateAnswerAction,
  gateAsksWords,
  gateHeld,
  gateReopenOption,
  gateWordsFor,
  isGateItem,
  toGateAction,
  toTestBesideGates,
} from '../../src/lib/gate-items.ts';
import { toTestCards } from '../../src/lib/to-test-inbox.ts';
import { agendaItem } from '../support/agenda-inbox.tsx';
import { boardModelOf, card } from './board-support.ts';

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
  } as Partial<AgendaItem>);

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
    expect(gateHeld(item, send('Not good'))).toBe(true);
    expect(gateHeld(item, send('Not good', '   '))).toBe(true);
    expect(gateHeld(item, send('Not good', 'blank'))).toBe(false);
  });

  test('the forward option needs none', () => {
    expect(gateWordsFor(item, send('Done'))).toBe('none');
    expect(gateHeld(item, send('Done'))).toBe(false);
  });

  test('Not yet, an ask option outside gate.options, takes words but never needs them', () => {
    const one = gateItem(gate([['OK to build', 'lane']]), {
      answers: [
        { direction: 'left', does: 'choose', label: 'OK to build' },
        { direction: 'right', does: 'choose', label: 'Not yet' },
      ],
    } as Partial<AgendaItem>);
    expect(gateWordsFor(one, send('Not yet'))).toBe('optional');
    expect(gateHeld(one, send('Not yet'))).toBe(false);
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

  test('finds the reopen option', () => {
    expect(gateReopenOption(item as never)?.label).toBe('Not good');
  });
});

describe('a gate attached to a thread', () => {
  const thread = agendaItem('A2', {
    subject: 'Which colour?',
    waitingOn: 'ferret',
    gateAttached: twoOptions,
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
    expect(attachedGateLead(twoOptions)).toBe('is ready to test.');
    const review = { ...twoOptions, laneName: 'Review', options: [{ ...twoOptions.options[0], outcome: 'advance' }] };
    expect(attachedGateLead({ ...review, cardTitle: 'Badge colour' } as never)).toBe('Badge colour is at Review.');
    expect(attachedGateLead(review as never)).toBe('is at Review.');
  });

  test('is nothing for an item with no attachment, a gate item or a notice', () => {
    expect(attachedGateView(agendaItem('A1'))).toBeUndefined();
    expect(attachedGateView(gateItem(twoOptions, { gateAttached: twoOptions } as Partial<AgendaItem>))).toBeUndefined();
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
    expect(gateHeld(thread, marked)).toBe(true);
    expect(gateAsksWords(thread, marked)).toBe(true);
    expect(gateWordsFor(thread, gateAnswerAction('Not good', ''))).toBe('none');
    expect(gateWordsFor(thread, gateAnswerAction('Done', '', true))).toBe('none');
  });
});

describe('the health switch: gate items replace to-test rows only where the machine advertises them', () => {
  const MACHINE = 'daemon-a' as DaemonId;
  const OTHER = 'daemon-b' as DaemonId;

  const rowsOf = async (...ids: string[]) =>
    toTestCards(await boardModelOf(ids.map(id => card(id, { laneId: 'tested' })))).map(row => ({
      ...row,
      card: { ...row.card, daemonId: MACHINE },
    }));

  test('a covered row is hidden on a machine that offers gate items', async () => {
    const rows = await rowsOf('F1', 'F2');
    const shown = toTestBesideGates(rows, [{ daemonId: MACHINE, item: gateItem(twoOptions) }], () => true);
    expect(shown.map(row => row.card.task.id)).toEqual(['F2']);
  });

  test('without the flag every row stays, gate item or not', async () => {
    const rows = await rowsOf('F1', 'F2');
    const shown = toTestBesideGates(rows, [{ daemonId: MACHINE, item: gateItem(twoOptions) }], () => false);
    expect(shown.map(row => row.card.task.id)).toEqual(['F1', 'F2']);
  });

  test('with the flag a card with no open gate item keeps its row', async () => {
    const rows = await rowsOf('F1');
    expect(toTestBesideGates(rows, [], () => true).map(row => row.card.task.id)).toEqual(['F1']);
  });

  test('a gate item on another machine covers nothing here', async () => {
    const rows = await rowsOf('F1');
    const shown = toTestBesideGates(rows, [{ daemonId: OTHER, item: gateItem(twoOptions) }], () => true);
    expect(shown).toHaveLength(1);
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
