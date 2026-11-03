import { describe, it } from 'bun:test';
import { type AgendaItem, agendaState, gateReference, MAX_AGENDA_HISTORY } from '@ferretry/protocol';
import should from 'should';
import {
  type AgendaActor,
  type AgendaLedger,
  applyAgendaCommand,
  applyAgendaCommandToSession,
} from '../../../src/lib/agenda/state-machine.ts';

/**
 * Where a ferret's thread ends up when the card asks on it come and go (docs/agenda.md § Card asks, Leaving), driven
 * through the real state machine, history bound included. The rules, one table row each:
 * (i) the seal is of the stored thread and is renewed by a card-ask write only if the thread matched it before;
 * (ii) a fresh seal is taken only when the first ask comes on a thread with none open;
 * (iii) the last open ask going rests the thread when the owner answered or said Not yet on any ask since, and
 *       restores the turn it woke the thread out of otherwise — all only on a thread that still matches;
 * (iv) a thread anybody else wrote on stays in Needs you.
 */

const START = Date.parse('2026-07-30T10:00:00Z');
const minute = (offset: number): string => new Date(START + offset * 60_000).toISOString();
const AGENT: AgendaActor = { kind: 'agent', sessionId: 'session-1', name: 'Ada' };
const SYSTEM: AgendaActor = { kind: 'daemon', cause: 'system' };

const ok = <T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> => {
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result as Extract<T, { ok: true }>;
};

const gateFor = (cardId: string) => ({
  cardId,
  laneId: 'tested',
  laneName: 'Try it',
  entry: 1,
  projectId: 'p1',
  options: [
    { id: 'o0', label: 'Done', outcome: 'close' as const },
    { id: 'o1', label: 'Not good', outcome: 'reopen-with-agenda' as const },
  ],
});

type Step =
  | readonly ['attach', string]
  | readonly ['restate', string]
  | readonly ['withdraw', string]
  | readonly ['answer', string]
  | readonly ['not-yet', string]
  | readonly ['ferret-answers']
  | readonly ['ferret-says']
  | readonly ['owner-replies'];

/** A ferret thread resting "working", then each step one minute after the last starting at minute 11. */
const play = (steps: readonly Step[], fill = 0): AgendaItem => {
  let ledger: AgendaLedger = ok(
    applyAgendaCommandToSession(null, 'session-1', {
      action: 'raise',
      actor: AGENT,
      at: minute(0),
      request: {
        source: 'agent-raised',
        sourceRef: null,
        subject: 'Approve?',
        why: 'Because.',
        context: 'ctx',
        premise: 'p',
        howToResolve: 'Approve',
        ask: { kind: 'permission' },
      },
    }),
  ).ledger;
  ledger = ok(
    applyAgendaCommand(ledger, { action: 'rest', actor: AGENT, id: 'A1', why: 'checking', at: minute(1) }),
  ).ledger;
  for (let i = 0; i < fill; i++) {
    ledger = ok(
      applyAgendaCommand(ledger, {
        action: 'card-ask',
        actor: SYSTEM,
        id: 'A1',
        operation: { kind: 'attach', ask: { gate: gateFor('F0') } },
        at: minute(2 + i),
      }),
    ).ledger;
    ledger = ok(
      applyAgendaCommand(ledger, {
        action: 'card-ask',
        actor: SYSTEM,
        id: 'A1',
        operation: { kind: 'withdraw', reference: gateReference(gateFor('F0')) },
        at: minute(2 + i),
      }),
    ).ledger;
  }
  steps.forEach(([kind, card], index) => {
    const at = minute(11 + index);
    const reference = gateReference(gateFor(card ?? 'F2'));
    const ask = (operation: object) =>
      applyAgendaCommand(ledger, { action: 'card-ask', actor: SYSTEM, id: 'A1', operation, at } as never);
    const next = (() => {
      switch (kind) {
        case 'attach':
          return ask({ kind: 'attach', ask: { gate: gateFor(card) } });
        case 'restate':
          return ask({
            kind: 'attach',
            ask: { gate: gateFor(card), howToTest: `Open the app, round ${String(index)}` },
          });
        case 'withdraw':
          return ask({ kind: 'withdraw', reference });
        case 'answer':
          return ask({
            kind: 'answered',
            reference,
            answer: { at, response: { kind: 'multiple-choice', choice: 'Done' }, receipt: 'a'.repeat(64) },
          });
        case 'not-yet':
          return ask({ kind: 'not-yet', reference });
        case 'ferret-answers':
          return applyAgendaCommand(ledger, {
            action: 'edit',
            actor: AGENT,
            id: 'A1',
            patch: { questionAnswer: 'Fixed it, try again' },
            at,
          });
        case 'ferret-says':
          return applyAgendaCommand(ledger, {
            action: 'edit',
            actor: AGENT,
            id: 'A1',
            patch: { subject: `Fixed it, round ${String(index)}` },
            at,
          });
        case 'owner-replies':
          return applyAgendaCommand(ledger, {
            action: 'reply',
            actor: { kind: 'human' },
            id: 'A1',
            note: 'what is this?',
            at,
          });
      }
    })();
    ledger = ok(next).ledger;
  });
  const item = ledger.entries.find(entry => entry.item.id === 'A1')?.item;
  if (item === undefined) throw new Error('the thread is gone');
  return item;
};

const shape = (item: AgendaItem): string => {
  const state = agendaState(item).state;
  return item.resting === undefined ? state : `${state}/${item.resting.sub}`;
};

interface Row {
  readonly name: string;
  readonly steps: readonly Step[];
  readonly ends: string;
}

const rows: readonly Row[] = [
  {
    name: 'one ask on and off',
    steps: [
      ['attach', 'F2'],
      ['withdraw', 'F2'],
    ],
    ends: 'resting/working',
  },
  {
    name: 'two asks, newer withdrawn then older',
    steps: [
      ['attach', 'F2'],
      ['attach', 'F3'],
      ['withdraw', 'F3'],
      ['withdraw', 'F2'],
    ],
    ends: 'resting/working',
  },
  {
    name: 'two asks, older withdrawn then newer',
    steps: [
      ['attach', 'F2'],
      ['attach', 'F3'],
      ['withdraw', 'F2'],
      ['withdraw', 'F3'],
    ],
    ends: 'resting/working',
  },
  {
    name: 'a restated ask on and off',
    steps: [
      ['attach', 'F2'],
      ['restate', 'F2'],
      ['withdraw', 'F2'],
    ],
    ends: 'resting/working',
  },
  {
    name: 'older answered, newer withdrawn (finding 3, the order that always worked)',
    steps: [
      ['attach', 'F2'],
      ['attach', 'F3'],
      ['answer', 'F2'],
      ['withdraw', 'F3'],
    ],
    ends: 'resting/waiting-on-ferret',
  },
  {
    name: 'newer answered, older withdrawn (P2)',
    steps: [
      ['attach', 'F2'],
      ['attach', 'F3'],
      ['answer', 'F3'],
      ['withdraw', 'F2'],
    ],
    ends: 'resting/waiting-on-ferret',
  },
  {
    name: 'newer said Not yet, older withdrawn (P3)',
    steps: [
      ['attach', 'F2'],
      ['attach', 'F3'],
      ['not-yet', 'F3'],
      ['withdraw', 'F2'],
    ],
    ends: 'resting/waiting-on-ferret',
  },
  {
    name: 'older said Not yet, newer withdrawn',
    steps: [
      ['attach', 'F2'],
      ['attach', 'F3'],
      ['not-yet', 'F2'],
      ['withdraw', 'F3'],
    ],
    ends: 'resting/waiting-on-ferret',
  },
  {
    name: 'its own Not yet, then withdrawn',
    steps: [
      ['attach', 'F2'],
      ['not-yet', 'F2'],
      ['withdraw', 'F2'],
    ],
    ends: 'resting/waiting-on-ferret',
  },
  {
    name: 'a second ask after a Not yet, then withdrawn, goes back to the rest the Not yet made',
    steps: [
      ['attach', 'F2'],
      ['not-yet', 'F2'],
      ['attach', 'F3'],
      ['withdraw', 'F3'],
    ],
    ends: 'resting/waiting-on-ferret',
  },
  {
    name: 'the ferret answered after a Not yet, a restate, then the ask withdrawn (P5)',
    steps: [['attach', 'F2'], ['not-yet', 'F2'], ['ferret-answers'], ['restate', 'F2'], ['withdraw', 'F2']],
    ends: 'needs-you',
  },
  {
    name: 'the same without the restate (P5 control)',
    steps: [['attach', 'F2'], ['not-yet', 'F2'], ['ferret-answers'], ['withdraw', 'F2']],
    ends: 'needs-you',
  },
  {
    name: 'the ferret answered after a Not yet, a new ask on and off, then the first withdrawn (P6)',
    steps: [
      ['attach', 'F2'],
      ['not-yet', 'F2'],
      ['ferret-answers'],
      ['attach', 'F3'],
      ['withdraw', 'F3'],
      ['withdraw', 'F2'],
    ],
    ends: 'needs-you',
  },
  {
    name: 'the ferret answered, a new ask stays on while the older is withdrawn',
    steps: [
      ['attach', 'F2'],
      ['not-yet', 'F2'],
      ['ferret-answers'],
      ['attach', 'F3'],
      ['withdraw', 'F2'],
      ['withdraw', 'F3'],
    ],
    ends: 'needs-you',
  },
  {
    name: 'the ferret answered a Not yet, a restate of the other ask, both withdrawn',
    steps: [
      ['attach', 'F2'],
      ['attach', 'F3'],
      ['not-yet', 'F2'],
      ['ferret-answers'],
      ['restate', 'F3'],
      ['withdraw', 'F3'],
      ['withdraw', 'F2'],
    ],
    ends: 'needs-you',
  },
  {
    name: 'the owner replied after the ask woke it: the reply’s rest stays, not the one before the ask',
    steps: [['attach', 'F2'], ['owner-replies'], ['withdraw', 'F2']],
    ends: 'resting/waiting-on-ferret',
  },
  {
    name: 'the ferret spoke after the ask woke it',
    steps: [['attach', 'F2'], ['ferret-says'], ['withdraw', 'F2']],
    ends: 'needs-you',
  },
  {
    name: 'the ferret answered with no ask open, a new ask on and off goes back to its answer',
    steps: [['attach', 'F2'], ['answer', 'F2'], ['ferret-answers'], ['attach', 'F3'], ['withdraw', 'F3']],
    ends: 'needs-you',
  },
];

describe('where a ferret’s thread ends up when its card asks come and go', () => {
  for (const row of rows) {
    it(`${row.name}: ${row.ends}`, () => {
      should(shape(play(row.steps))).equal(row.ends);
    });
  }

  it('does the same with the history at its bound, since the stored thread is what the seal covers (P1)', () => {
    // Arrange — more attach/withdraw cycles than the history holds lines
    const cycles = MAX_AGENDA_HISTORY;

    // Act
    const item = play(
      [
        ['attach', 'F2'],
        ['withdraw', 'F2'],
      ],
      cycles,
    );

    // Assert — every cycle went back to working, the last one included, and the stored history is at its bound
    should(shape(item)).equal('resting/working');
    should(item.history).have.length(MAX_AGENDA_HISTORY);
  });

  it('rests on a Not yet with the history at its bound too', () => {
    should(
      shape(
        play(
          [
            ['attach', 'F2'],
            ['not-yet', 'F2'],
            ['withdraw', 'F2'],
          ],
          MAX_AGENDA_HISTORY,
        ),
      ),
    ).equal('resting/waiting-on-ferret');
  });
});
