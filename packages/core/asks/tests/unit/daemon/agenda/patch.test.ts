import { describe, it } from 'bun:test';
import { AgendaItemSchema, agendaItemRevision } from '@ferretry/protocol';
import should from 'should';
import {
  type AgendaActor,
  type AgendaLedger,
  type AgendaMutation,
  agendaSnapshot,
  applyAgendaCommand,
  applyAgendaCommandToSession,
  type EditAgendaPatch,
} from '../../../src/lib/agenda/state-machine.ts';

/**
 * PATCHING AN ITEM (&F957; docs/agenda.md § Patch): an edit that names the revision it read is refused `stale` once the
 * item has moved on (read before write); it may rewrite the why and how-to-resolve lines; and `clear` takes the
 * optional writing a patch's `null` removes.
 */

const SESSION_ID = 'session-1';
const AT = '2026-11-04T08:00:00.000Z';
const LATER = '2026-11-04T09:00:00.000Z';
const AGENT: AgendaActor = { kind: 'agent', sessionId: SESSION_ID, name: 'Ada' };
const OTHER: AgendaActor = { kind: 'agent', sessionId: 'session-2', name: 'Grace' };

const ok = (result: AgendaMutation): Extract<AgendaMutation, { ok: true }> => {
  if (!result.ok) throw new Error(result.error.message);
  return result;
};

const raised = (): AgendaLedger =>
  ok(
    applyAgendaCommandToSession(null, SESSION_ID, {
      action: 'raise',
      actor: AGENT,
      request: {
        source: 'agent-raised',
        sourceRef: null,
        subject: 'Use the proposed wording?',
        premise: 'A plan is ready.',
        context: 'The plan is in the tabs.',
        why: 'Use the proposed wording for the three rules?',
        howToResolve: 'Say yes or no.',
        ask: { kind: 'open-question' },
        decided: 'Tabs by name.',
        detail: 'From zero.',
      },
      at: AT,
    }),
  ).ledger;

const edit = (ledger: AgendaLedger, patch: EditAgendaPatch, actor: AgendaActor = AGENT): AgendaMutation =>
  applyAgendaCommand(ledger, { action: 'edit', actor, id: 'A1', patch, at: LATER });

const open = (ledger: AgendaLedger) => {
  const found = agendaSnapshot(ledger).items.find(item => item.id === 'A1');
  if (found === undefined) throw new Error('no open A1');
  return found;
};

describe('an edit that names the revision it read', () => {
  it('should apply when the item is as it was read, and move the revision on', () => {
    // Arrange
    const ledger = raised();
    const revision = agendaItemRevision(open(ledger));

    // Act
    const item = open(ok(edit(ledger, { revision, why: 'Ship the wording this week?' })).ledger);

    // Assert
    should(item.why).equal('Ship the wording this week?');
    should(item.revisions?.[0]?.changed).deepEqual(['why']);
    should(agendaItemRevision(item)).not.equal(revision);
    should(AgendaItemSchema.safeParse(item).success).be.true();
  });

  it('should refuse `stale` when the item changed since it was read, and write nothing', () => {
    // Arrange: read, then somebody else's change lands first
    const ledger = raised();
    const revision = agendaItemRevision(open(ledger));
    const moved = ok(edit(ledger, { subject: 'Use the new wording?' })).ledger;

    // Act
    const refused = edit(moved, { revision, why: 'An old reading' });

    // Assert
    should(refused.ok).be.false();
    should(!refused.ok && refused.error.code).equal('stale');
    should(!refused.ok && refused.error.message).match(/A1 changed since you read it: read it again/u);
    should(open(moved).why).equal('Use the proposed wording for the three rules?');
  });

  it('should refuse `stale` when the item it read is no longer open, and write nothing', () => {
    // Arrange: read it, then it closes
    const ledger = raised();
    const revision = agendaItemRevision(open(ledger));
    const closed = ok(
      applyAgendaCommand(ledger, { action: 'resolve', actor: { kind: 'human' }, id: 'A1', at: LATER }),
    ).ledger;

    // Act
    const refused = edit(closed, { revision, why: 'An old reading' });

    // Assert
    should(!refused.ok && refused.error.code).equal('stale');
    should(!refused.ok && refused.error.message).match(/A1 is no longer open: read it again/u);
  });

  it('should still refuse another ferret’s item, revision or not', () => {
    // Arrange
    const ledger = raised();

    // Act
    const refused = edit(ledger, { revision: agendaItemRevision(open(ledger)), why: 'Not mine' }, OTHER);

    // Assert
    should(!refused.ok && refused.error.code).equal('forbidden');
  });

  it('should clear the optional writing a patch’s null removes, and rewrite how to resolve', () => {
    // Arrange
    const ledger = raised();

    // Act
    const item = open(ok(edit(ledger, { clear: ['decided', 'detail'], howToResolve: 'Pick one.' })).ledger);

    // Assert
    should(item.decided).be.undefined();
    should(item.detail).be.undefined();
    should(item.howToResolve).equal('Pick one.');
    should(item.revisions?.[0]?.changed).containDeep(['howToResolve', 'decided', 'detail']);
  });
});
