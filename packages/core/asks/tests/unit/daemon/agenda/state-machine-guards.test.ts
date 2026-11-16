import { describe, it } from 'bun:test';
import should from 'should';
import {
  type AgendaActor,
  type AgendaEntry,
  type AgendaLedger,
  type AgendaMutation,
  agendaLedgerDocument,
  applyAgendaCommand,
  applyAgendaCommandToSession,
  parseAgendaLedger,
  type RaiseAgendaRequest,
} from '../../../../daemon/lib/agenda/state-machine.ts';
import { cardAgendaReference } from '../../../../daemon/lib/protocol/agenda-card-asks.ts';
import { gateReference } from '../../../../daemon/lib/protocol/agenda-gate.ts';
import { agendaState } from '../../../../daemon/lib/protocol/agenda-state.ts';
import type { AgendaItem } from '../../../../daemon/lib/protocol/agenda.ts';

const SESSION = 'session-1';
const AT = '2026-07-30T10:00:00Z';
const LATER = '2026-07-30T11:00:00Z';
const HUMAN: AgendaActor = { kind: 'human' };
const AGENT: AgendaActor = { kind: 'agent', sessionId: SESSION, name: 'Ada' };
const DAEMON: AgendaActor = { kind: 'daemon', cause: 'system' };

const request = (overrides: Partial<RaiseAgendaRequest> = {}): RaiseAgendaRequest => ({
  source: 'agent-raised',
  sourceRef: null,
  subject: 'Approve the deployment?',
  why: 'The release cannot proceed without a human decision.',
  context: 'This deploy changes the public service.',
  premise: 'A release is ready to go out.',
  howToResolve: 'Approve or reject the request.',
  ask: { kind: 'permission' },
  ...overrides,
});

const succeeded = (mutation: AgendaMutation) => {
  if (!mutation.ok) throw new Error(`${mutation.error.code}: ${mutation.error.message}`);
  return mutation;
};

const raise = (actor: AgendaActor, overrides: Partial<RaiseAgendaRequest> = {}, ledger: AgendaLedger | null = null) =>
  succeeded(
    applyAgendaCommandToSession(ledger, SESSION, { action: 'raise', actor, request: request(overrides), at: AT }),
  );

/** The ledger with the item changed the way only another writer could have (the guards read the stored item). */
const withItem = (ledger: AgendaLedger, change: Partial<AgendaItem>): AgendaLedger => ({
  ...ledger,
  entries: ledger.entries.map(entry =>
    entry.lifecycle === 'active' ? ({ ...entry, item: { ...entry.item, ...change } } as AgendaEntry) : entry,
  ),
});

describe('an answer to an item that only its own card can answer', () => {
  const cases: readonly (readonly [string, Partial<AgendaItem>, string])[] = [
    [
      'a task plan',
      { taskPlan: {} } as never,
      'A1 is a task plan: answer it on its card in the app, where a sign-in is confirmed with your passkey',
    ],
    [
      'a standing-rule suggestion',
      { signInRuleSuggestion: {} } as never,
      'A1 suggests a standing rule: open it in the app, where you choose what to allow and confirm with your passkey',
    ],
    ['a paste plan', { copyPlan: {} } as never, 'A1 is a paste plan: answer it on its card, or with fy plan approve'],
    [
      'a staged 2FA key',
      { twoFactorSeed: {} } as never,
      'A1 saves a 2FA key: allow it on its card in the app, with your passkey',
    ],
    [
      'a sign-in to approve on the phone',
      { phoneApproval: {} } as never,
      'A1 is a sign-in to approve on your phone: approve it there, or tap Not me on its card',
    ],
  ];

  for (const [name, planted, message] of cases) {
    it(`should refuse the owner's agenda answer to ${name}, pointing to its card`, () => {
      // Arrange
      const ledger = withItem(raise(AGENT).ledger, planted);

      // Act
      const result = applyAgendaCommand(ledger, {
        action: 'answer',
        actor: HUMAN,
        id: 'A1',
        response: { kind: 'permission', decision: 'approve' },
        at: LATER,
      });

      // Assert
      should(result.ok).be.false();
      should(!result.ok && result.error).eql({ code: 'use_input_form', message });
    });
  }
});

describe('a ferret’s standing-rule suggestion', () => {
  it('should be frozen to everyone but the daemon, so the ferret never tells the owner’s no from silence', () => {
    // Arrange
    const ledger = withItem(raise(AGENT).ledger, { signInRuleSuggestion: {} } as never);

    // Act
    const edited = applyAgendaCommand(ledger, {
      action: 'edit',
      actor: AGENT,
      id: 'A1',
      patch: { subject: 'Changed my mind' },
      at: LATER,
    });
    const dismissed = applyAgendaCommand(ledger, { action: 'dismiss', actor: HUMAN, id: 'A1', at: LATER });

    // Assert
    for (const result of [edited, dismissed]) {
      should(result.ok).be.false();
      should(!result.ok && result.error.code).equal('use_input_form');
      should(!result.ok && result.error.message).startWith("A1 is a ferret's rule suggestion: Dismiss it on its card");
    }
  });
});

describe('an ask the daemon raised for a source obligation', () => {
  it('should be raised once: the same obligation raised again changes nothing', () => {
    // Arrange
    const first = raise(DAEMON, { source: 'question', sourceRef: 'ask:q1', ask: { kind: 'open-question' } });

    // Act
    const again = succeeded(
      applyAgendaCommand(first.ledger, {
        action: 'raise',
        actor: DAEMON,
        request: request({ source: 'question', sourceRef: 'ask:q1', ask: { kind: 'open-question' } }),
        at: LATER,
      }),
    );

    // Assert
    should(first.ledger.raisedObligations).eql({ 'ask:q1': 'A1' });
    should(again.changed).be.false();
    should(again.ledger.entries).have.length(1);
  });
});

describe('an item raised to start in discussion', () => {
  it('should wait on the ferret, not the owner', () => {
    // Act
    const result = raise(DAEMON, { discussion: true });

    // Assert
    const view = agendaState(result.item as AgendaItem);
    should(result.item).containDeep({ waitingOn: 'ferret', askedAt: AT, waitingFor: 'discussion' });
    should(view.state).not.equal('needs-you');
  });
});

describe('a ledger read back from storage', () => {
  const stored = (): Record<string, unknown> =>
    JSON.parse(agendaLedgerDocument(raise(AGENT).ledger)) as Record<string, unknown>;

  it('should refuse conversations that are not threads of conversation entries', () => {
    should(parseAgendaLedger({ ...stored(), conversations: { A1: 'not a thread' } }, SESSION)).be.null();
  });

  it('should refuse raised obligations that name no ask, or an item not yet issued', () => {
    should(parseAgendaLedger({ ...stored(), raisedObligations: { 'notes:q1': 'A1' } }, SESSION)).be.null();
    should(parseAgendaLedger({ ...stored(), raisedObligations: { 'ask:q1': 'A9' } }, SESSION)).be.null();
  });

  it('should refuse carried entries that are not a record of entries filed under their own ids', () => {
    // Arrange
    const document = stored();
    const entry = (document.entries as unknown[])[0];

    // Assert
    should(parseAgendaLedger({ ...document, carriedEntries: null }, SESSION)).be.null();
    should(parseAgendaLedger({ ...document, carriedEntries: [] }, SESSION)).be.null();
    should(parseAgendaLedger({ ...document, carriedEntries: 'A1' }, SESSION)).be.null();
    should(parseAgendaLedger({ ...document, carriedEntries: { A1: 'not an entry' } }, SESSION)).be.null();
    should(parseAgendaLedger({ ...document, carriedEntries: { A7: entry } }, SESSION)).be.null();
  });
});

describe('the agenda of a card, when its only ask is withdrawn', () => {
  it('should close as the daemon’s own item, with the note that nothing is left to answer', () => {
    // Arrange
    const gate = {
      cardId: 'F1',
      laneId: 'tested',
      laneName: 'Try it',
      entry: 1,
      projectId: 'p1',
      cardTitle: 'Badge',
      options: [{ id: 'o0', label: 'Done', outcome: 'close' as const }],
    };
    const opened = raise(DAEMON, { source: 'task', sourceRef: cardAgendaReference('F1'), task: { id: 'F1' } });
    const asked = succeeded(
      applyAgendaCommand(opened.ledger, {
        action: 'card-ask',
        actor: DAEMON,
        id: 'A1',
        operation: { kind: 'attach', ask: { gate } },
        at: LATER,
      }),
    );

    // Act
    const closed = succeeded(
      applyAgendaCommand(asked.ledger, {
        action: 'card-ask',
        actor: DAEMON,
        id: 'A1',
        operation: { kind: 'withdraw', reference: gateReference(gate) },
        at: '2026-07-30T12:00:00Z',
      }),
    );

    // Assert
    should(closed.change).equal('resolved');
    should(closed.snapshot.items).have.length(0);
    should(closed.snapshot.resolved[0]).containDeep({ id: 'A1', disposition: 'done' });
    should(closed.snapshot.resolved[0]?.history?.at(-1)?.note).equal('&F1 moved on, so nothing is left to answer');
  });
});
