import { describe, expect, test } from 'bun:test';
import type { AgendaItem } from '@ferretry/protocol';
import { swipeTargets } from '../../src/lib/agenda-answers.ts';
import type { DaemonId } from '../../src/lib/daemon-connection.ts';
import {
  gateAnswerAction,
  gateHeld,
  gateReopenOption,
  gateWordsFor,
  isGateItem,
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
    // The daemon lays the options out left · up · right: the forward option first (Done), Not good last.
    ask: { kind: 'multiple-choice', options: g.options.map(option => ({ label: option.label })) },
    gate: g,
    answers: [
      { direction: 'left', does: 'choose', label: g.options[0]?.label ?? '' },
      { direction: 'right', does: 'choose', label: g.options[1]?.label ?? '' },
    ],
    ...extra,
  } as Partial<AgendaItem>);

const twoOptions = gate([
  ['Done', 'close'],
  ['Not good', 'reopen-with-agenda'],
]);

describe('a gate item answers as a plain multiple choice', () => {
  test('← is the forward option and sends the choice, nothing else', () => {
    const targets = swipeTargets(gateItem(twoOptions));
    expect(targets.left?.action).toEqual({
      kind: 'respond',
      label: 'Done',
      response: { kind: 'multiple-choice', choice: 'Done' },
    });
  });

  test('→ is Not good, and it carries the words as the note', () => {
    expect(swipeTargets(gateItem(twoOptions), 'The QR is blank').right?.action).toEqual({
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

  test('an item without a gate holds nothing', () => {
    const plain = agendaItem('A1');
    expect(isGateItem(plain)).toBe(false);
    expect(gateWordsFor(plain, send('Not good'))).toBe('none');
  });

  test('finds the reopen option', () => {
    expect(gateReopenOption(item as never)?.label).toBe('Not good');
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
