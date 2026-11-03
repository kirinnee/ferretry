import { describe, it } from 'bun:test';
import {
  AgendaActionRequestSchema,
  AgendaItemSchema,
  MAX_AGENDA_CONTENT_LENGTH,
  MAX_AGENDA_ITEM_LENGTH,
  ResolvedAgendaItemSchema,
  agendaContentLength,
  fitAgendaItem,
} from '@ferretry/protocol';
import should from 'should';
import {
  type AgendaActor,
  type AgendaLedger,
  type AgendaMutation,
  type RaiseAgendaRequest,
  agendaSnapshot,
  applyAgendaCommand,
  applyAgendaCommandToSession,
  parseAgendaLedger,
} from '../../../src/lib/agenda/state-machine.ts';

/**
 * A LONG ITEM STAYS CLOSABLE (docs/agenda.md § No size limit): its content is bounded well under the transport bound,
 * and what it adds when it is edited, answered or closed is made room for by shedding its oldest versions.
 */

const SESSION_ID = 'session-1';
const AT = '2026-11-03T08:00:00.000Z';
const HUMAN: AgendaActor = { kind: 'human' };
const AGENT: AgendaActor = { kind: 'agent', sessionId: SESSION_ID, name: 'Ada' };

const ok = (result: AgendaMutation): Extract<AgendaMutation, { ok: true }> => {
  if (!result.ok) throw new Error(result.error.message);
  return result;
};

const longRequest = (filler: string): RaiseAgendaRequest => ({
  source: 'agent-raised',
  sourceRef: null,
  subject: 'Read the report',
  premise: 'A report is ready.',
  why: 'It is long.',
  howToResolve: 'Read it.',
  kind: 'task',
  ask: { kind: 'task' },
  body: filler.repeat(200_000),
  whereWeAre: filler.repeat(200_000),
  detail: filler.repeat(80_000),
  context: filler.repeat(40_000),
});

/** A board whose A1 weighs just under the content bound and carries a full set of retained versions. */
function heavyBoard(): AgendaLedger {
  let ledger = ok(
    applyAgendaCommandToSession(null, SESSION_ID, { action: 'raise', actor: AGENT, request: longRequest('a'), at: AT }),
  ).ledger;
  for (const filler of ['b', 'c', 'd', 'e', 'f', 'g']) {
    ledger = ok(
      applyAgendaCommand(ledger, {
        action: 'edit',
        actor: AGENT,
        id: 'A1',
        patch: { body: filler.repeat(200_000), whereWeAre: filler.repeat(200_000) },
        at: AT,
      }),
    ).ledger;
  }
  return ledger;
}

const open = (ledger: AgendaLedger) => {
  const found = agendaSnapshot(ledger).items.find(item => item.id === 'A1');
  if (found === undefined) throw new Error('no open A1');
  return found;
};

describe('a long agenda item', () => {
  it('should keep its content under the bound and every edit of it inside the transport bound', () => {
    // Act
    const ledger = heavyBoard();

    // Assert
    should(agendaContentLength(open(ledger))).be.belowOrEqual(MAX_AGENDA_CONTENT_LENGTH);
    should(JSON.stringify(open(ledger)).length).be.belowOrEqual(MAX_AGENDA_ITEM_LENGTH);
    should(AgendaItemSchema.safeParse(open(ledger)).success).be.true();
    should(open(ledger).revisions?.length ?? 0).be.lessThan(6);
  });

  it('should still be shortened, rested, resolved and dismissed', () => {
    // Arrange
    const ledger = heavyBoard();

    // Act
    const shortened = ok(
      applyAgendaCommand(ledger, { action: 'edit', actor: AGENT, id: 'A1', patch: { body: 'short' }, at: AT }),
    );
    const rested = ok(
      applyAgendaCommand(ledger, { action: 'rest', actor: AGENT, id: 'A1', why: 'reading it', at: AT }),
    );
    const resolved = ok(
      applyAgendaCommand(ledger, { action: 'resolve', actor: HUMAN, id: 'A1', note: 'read', at: AT }),
    );
    const dismissed = ok(applyAgendaCommand(ledger, { action: 'dismiss', actor: HUMAN, id: 'A1', at: AT }));

    // Assert
    should(open(shortened.ledger).body).equal('short');
    should(open(rested.ledger).resting?.sub).equal('working');
    for (const closed of [resolved, dismissed]) {
      const item = closed.addressed;
      should(item).not.be.undefined();
      should(JSON.stringify(item).length).be.belowOrEqual(MAX_AGENDA_ITEM_LENGTH);
      should(ResolvedAgendaItemSchema.safeParse(item).success).be.true();
      should(agendaSnapshot(closed.ledger).resolved.map(each => each.id)).deepEqual(['A1']);
    }
  });

  it('should read back from a serialized ledger after it was shed to fit', () => {
    // Act
    const reread = parseAgendaLedger(JSON.parse(JSON.stringify(heavyBoard())), SESSION_ID);

    // Assert
    should(reread).not.be.null();
    should(reread === null ? 0 : agendaSnapshot(reread).items.length).equal(1);
  });

  it('should refuse a wire add whose own content is over the bound, naming the bound', () => {
    // Act
    const parsed = AgendaActionRequestSchema.safeParse({
      action: 'add',
      ...longRequest('x'),
      questionAnswer: 'x'.repeat(200_000),
    });

    // Assert
    should(parsed.success).be.false();
    should(JSON.stringify(parsed.error?.issues)).containEql(`${MAX_AGENDA_CONTENT_LENGTH} characters`);
  });

  it('should shed revisions before history, and never a gate answer, when fitting', () => {
    // Arrange
    const big = 'x'.repeat(100_000);
    const item = {
      filler: 'y'.repeat(600_000),
      revisions: [
        { n: 1, big },
        { n: 2, big },
        { n: 3, big },
        { n: 4, big },
      ],
      history: [
        { kind: 'replied', note: big },
        { kind: 'gate-answered', note: 'gate:F1:tested:1' },
        { kind: 'updated', note: big },
      ],
    };

    // Act
    const fitted = fitAgendaItem(item);

    // Assert
    should(JSON.stringify(fitted).length).be.belowOrEqual(MAX_AGENDA_ITEM_LENGTH);
    should(fitted.revisions?.length ?? 0).be.lessThan(4);
    should(fitted.history?.some(entry => entry.kind === 'gate-answered')).be.true();
    should(fitAgendaItem({ filler: 'z', history: [{ kind: 'replied' }] })).deepEqual({
      filler: 'z',
      history: [{ kind: 'replied' }],
    });
  });
});
