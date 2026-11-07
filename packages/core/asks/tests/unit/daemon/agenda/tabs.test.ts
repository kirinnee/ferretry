import { describe, it } from 'bun:test';
import { AgendaItemSchema } from '../../../../daemon/lib/protocol/agenda.ts';
import should from 'should';
import {
  type AgendaActor,
  type AgendaLedger,
  type AgendaMutation,
  agendaSnapshot,
  applyAgendaCommand,
  applyAgendaCommandToSession,
  type EditAgendaPatch,
} from '../../../../daemon/lib/agenda/state-machine.ts';

/**
 * THE ITEM'S TABS (&F923; docs/agenda.md § The tabs): an edit's tab operations become the new `tabs` through the
 * ordinary edit path — one edit, one version, one revision — and a refusal says why in plain words.
 */

const SESSION_ID = 'session-1';
const AT = '2026-11-04T08:00:00.000Z';
const LATER = '2026-11-04T09:00:00.000Z';
const AGENT: AgendaActor = { kind: 'agent', sessionId: SESSION_ID, name: 'Ada' };

const ok = (result: AgendaMutation): Extract<AgendaMutation, { ok: true }> => {
  if (!result.ok) throw new Error(result.error.message);
  return result;
};

function raised(tabs?: EditAgendaPatch['tabs']): AgendaLedger {
  return ok(
    applyAgendaCommandToSession(null, SESSION_ID, {
      action: 'raise',
      actor: AGENT,
      request: {
        source: 'agent-raised',
        sourceRef: null,
        subject: 'Read the plan',
        premise: 'A plan is ready.',
        context: 'The plan is in the tabs.',
        why: 'It needs a read.',
        howToResolve: 'Read it.',
        ask: { kind: 'open-question' },
        whereWeAre: '## Status\nPlanning.',
        ...(tabs === undefined ? {} : { tabs }),
      },
      at: AT,
    }),
  ).ledger;
}

const editTabs = (ledger: AgendaLedger, patch: EditAgendaPatch): AgendaMutation =>
  applyAgendaCommand(ledger, { action: 'edit', actor: AGENT, id: 'A1', patch, at: LATER });

const open = (ledger: AgendaLedger) => {
  const found = agendaSnapshot(ledger).items.find(item => item.id === 'A1');
  if (found === undefined) throw new Error('no open A1');
  return found;
};

describe('an edit’s tab operations', () => {
  it('should store the whole new list as one edit, with one revision that keeps the tabs as they were', () => {
    const ledger = raised([{ id: 'status', name: 'Status', body: 'Planning.' }]);
    const edited = ok(
      editTabs(ledger, {
        tabEdits: [
          { tab: 'Decisions', body: 'SQLite.' },
          { tab: 'status', body: 'Building.' },
          { tab: 'Decisions', position: 1 },
        ],
      }),
    ).ledger;
    const item = open(edited);
    should(item.tabs).deepEqual([
      { id: 'decisions', name: 'Decisions', body: 'SQLite.' },
      { id: 'status', name: 'Status', body: 'Building.' },
    ]);
    should(item.revisions).have.length(1);
    should(item.revisions?.[0]?.changed).deepEqual(['tabs']);
    should(item.revisions?.[0]?.previous.tabs).deepEqual([{ id: 'status', name: 'Status', body: 'Planning.' }]);
    should(AgendaItemSchema.safeParse(item).success).be.true();
  });

  it('should clear the tabs when every one is removed, and keep a raise’s tabs as given', () => {
    const ledger = raised([{ id: 'status', name: 'Status', body: 'Planning.' }]);
    should(open(ledger).tabs).deepEqual([{ id: 'status', name: 'Status', body: 'Planning.' }]);
    const item = open(ok(editTabs(ledger, { tabEdits: [{ tab: 'Status', remove: true }] })).ledger);
    should(item.tabs).be.undefined();
    should(item.revisions?.[0]?.changed).deepEqual(['tabs']);
  });

  it('should refuse an operation that cannot apply, or tabs and tab operations together', () => {
    const ledger = raised();
    const refused = editTabs(ledger, { tabEdits: [{ tab: 'Risks', remove: true }] });
    should(refused.ok).be.false();
    should(!refused.ok && refused.error).containDeep({ code: 'invalid', message: 'there is no tab "Risks" to remove' });
    const both = editTabs(ledger, {
      tabs: [{ id: 'a', name: 'A', body: 'x' }],
      tabEdits: [{ tab: 'B', body: 'y' }],
    });
    should(!both.ok && both.error.message).equal('an edit gives tabs or tab operations, not both');
  });

  it('should change nothing when the tab already says it', () => {
    const ledger = raised([{ id: 'status', name: 'Status', body: 'Planning.' }]);
    const same = ok(editTabs(ledger, { tabEdits: [{ tab: 'Status', body: 'Planning.' }] }));
    should(open(same.ledger).revisions ?? []).have.length(0);
  });
});
