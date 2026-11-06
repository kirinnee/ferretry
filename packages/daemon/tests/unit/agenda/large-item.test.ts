import { describe, it } from 'bun:test';
import {
  AgendaActionRequestSchema,
  AgendaItemSchema,
  agendaContentLength,
  fitAgendaItem,
  MAX_AGENDA_CONTENT_LENGTH,
  MAX_AGENDA_GATE_HISTORY_LENGTH,
  MAX_AGENDA_ITEM_LENGTH,
  ResolvedAgendaItemSchema,
} from '@ferretry/protocol';
import should from 'should';
import {
  type AgendaActor,
  type AgendaLedger,
  type AgendaMutation,
  agendaLedgerDocument,
  agendaSnapshot,
  applyAgendaCommand,
  applyAgendaCommandToSession,
  parseAgendaLedger,
  type RaiseAgendaRequest,
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

function heavyQuestionBoard(): AgendaLedger {
  const ledger = heavyBoard();
  return {
    ...ledger,
    entries: ledger.entries.map(
      entry =>
        ({
          ...entry,
          item: { ...entry.item, detail: 'd'.repeat(118_000), ask: { kind: 'open-question' as const } },
        }) as typeof entry,
    ),
  };
}

describe('a long agenda item', () => {
  it('should migrate an old-schema-valid megabyte of escaped versions before enforcing wire limits', () => {
    const payload = (n: number) => ({
      body: `${n % 10}${'\\'.repeat(7_999)}`,
      steps: Array.from({ length: 20 }, (_, i) => `${(i + n) % 10}${'\\'.repeat(1_999)}`),
    });
    const seed = ok(
      applyAgendaCommandToSession(null, SESSION_ID, {
        action: 'raise',
        actor: AGENT,
        at: AT,
        request: { ...longRequest('a'), body: 'small', whereWeAre: undefined, detail: undefined, context: 'Context' },
      }),
    );
    const item = {
      ...seed.item,
      ...payload(10),
      revisions: Array.from({ length: 10 }, (_, n) => ({
        at: AT,
        by: 'agent',
        changed: ['body', 'steps'],
        previous: payload(n),
      })),
    };
    should(JSON.stringify(item).length).be.above(MAX_AGENDA_ITEM_LENGTH);
    const raw = { ...seed.ledger, version: undefined, entries: [{ ...seed.ledger.entries[0], item }] };
    const migrated = parseAgendaLedger(raw, SESSION_ID);
    if (migrated === null) throw new Error('legacy board did not read');
    should(migrated.unreadable).be.undefined();
    should(agendaSnapshot(migrated).count).equal(1);
    should(AgendaItemSchema.safeParse(open(migrated)).success).be.true();
    should(open(migrated).body).equal(item.body);
    should(open(migrated).steps).deepEqual(item.steps);
    should(migrated.archivePending).deepEqual([{ kind: 'version', id: 'A1', item }]);
    should(parseAgendaLedger(JSON.parse(agendaLedgerDocument(migrated)), SESSION_ID)).deepEqual(migrated);
    for (const command of [
      { action: 'rest' as const, why: 'Reading' },
      { action: 'resolve' as const, note: 'Finished' },
      { action: 'edit' as const, patch: { body: 'short' } },
    ])
      should(ok(applyAgendaCommand(migrated, { ...command, actor: AGENT, id: 'A1', at: AT })).changed).be.true();
  });

  it('should reserve every owner transition at exactly the accepted content limit', () => {
    const raisedAt = '2026-11-03T08:00:00Z';
    const request = {
      ...longRequest('a'),
      ask: { kind: 'open-question' as const },
      detail: 'd'.repeat(110_000),
      questionAnswer: 'Ready0',
      steps: ['First', 'Second'],
    };
    const seed = ok(
      applyAgendaCommandToSession(null, SESSION_ID, { action: 'raise', actor: AGENT, request, at: raisedAt }),
    );
    request.detail += 'd'.repeat(MAX_AGENDA_CONTENT_LENGTH - agendaContentLength(open(seed.ledger)));
    should(AgendaActionRequestSchema.safeParse({ action: 'add', ...request }).success).be.true();
    const base = ok(
      applyAgendaCommandToSession(null, SESSION_ID, { action: 'raise', actor: AGENT, request, at: raisedAt }),
    );
    should(agendaContentLength(open(base.ledger))).equal(MAX_AGENDA_CONTENT_LENGTH);
    // Answer, Needs info, Discuss, Rest, Done, shrink, progress, snooze and wake all fit without editing content.
    const commands = [
      { action: 'answer', actor: HUMAN, response: { kind: 'open-question', answer: 'Yes' } },
      { action: 'needs-info', actor: HUMAN, note: 'More please' },
      { action: 'discuss', actor: HUMAN, note: 'Discuss please' },
      { action: 'reply', actor: HUMAN, note: 'My reply' },
      { action: 'rest', actor: AGENT, why: 'Working' },
      { action: 'resolve', actor: HUMAN, note: 'Finished' },
      { action: 'dismiss', actor: HUMAN },
      { action: 'edit', actor: AGENT, patch: { body: 'short' } },
      { action: 'progress', actor: HUMAN, step: 0, done: true },
      { action: 'snooze', actor: HUMAN, until: '2026-11-03T09:00:00.000Z' },
    ] as const;
    for (const command of commands) {
      const changed = ok(applyAgendaCommand(base.ledger, { ...command, id: 'A1', at: AT }));
      const item = changed.item ?? changed.addressed;
      should(JSON.stringify(item).length).be.belowOrEqual(MAX_AGENDA_ITEM_LENGTH);
      should(
        (changed.addressed === undefined ? AgendaItemSchema : ResolvedAgendaItemSchema).safeParse(item).success,
      ).be.true();
    }
    const rested = ok(
      applyAgendaCommand(base.ledger, { action: 'rest', actor: AGENT, id: 'A1', why: 'Working', at: AT }),
    );
    const resurfaced = ok(
      applyAgendaCommand(rested.ledger, {
        action: 'edit',
        actor: AGENT,
        id: 'A1',
        patch: { questionAnswer: 'Ready1' },
        at: AT,
      }),
    );
    should(agendaContentLength(open(resurfaced.ledger))).equal(MAX_AGENDA_CONTENT_LENGTH);
    should(open(resurfaced.ledger).waitingSince).equal(AT);
  });
  it('should reserve gate receipts and reject an oversized stored closing envelope', () => {
    const item = open(heavyQuestionBoard());
    const receipt = { at: AT, kind: 'gate-answered', note: 'r'.repeat(MAX_AGENDA_GATE_HISTORY_LENGTH) };
    const gate = AgendaItemSchema.safeParse({ ...item, history: [receipt] });
    should(gate.success).be.false();
    should(JSON.stringify(gate.error?.issues)).containEql('gate receipts');
    const closed = ResolvedAgendaItemSchema.safeParse({
      ...item,
      resolvedAt: AT,
      disposition: 'done',
      resolvedBy: 'human',
      resolvedBySession: null,
      resolvedByName: null,
      resolutionNote: '\u0000'.repeat(30_000),
    });
    should(closed.success).be.false();
    should(JSON.stringify(closed.error?.issues)).containEql('answer plus note');
  });

  it('should keep the full pending Retry when the owner snoozes its card', () => {
    const answered = ok(
      applyAgendaCommand(heavyQuestionBoard(), {
        action: 'answer',
        actor: HUMAN,
        id: 'A1',
        response: { kind: 'open-question', answer: 'a'.repeat(9_000) },
        note: 'n'.repeat(3_000),
        at: AT,
      }),
    );
    const failed = ok(
      applyAgendaCommand(answered.ledger, {
        action: 'undelivered',
        actor: { kind: 'daemon', cause: 'system' },
        id: 'A1',
        request: 1,
        reason: 'offline',
        at: AT,
      }),
    );
    const snoozed = ok(
      applyAgendaCommand(failed.ledger, {
        action: 'snooze',
        actor: HUMAN,
        id: 'A1',
        until: '2026-11-03T09:00:00.000Z',
        at: AT,
      }),
    );
    should(open(snoozed.ledger).parked?.reason).equal('snoozed');
    should(open(snoozed.ledger).undelivered).deepEqual(open(failed.ledger).undelivered);
  });
  it('should archive every owner answer before compaction, including past twenty history entries', () => {
    let ledger = heavyQuestionBoard();
    for (let round = 1; round <= 23; round++) {
      const response = { kind: 'open-question' as const, answer: `OWNER_RESPONSE_${round}:${'a'.repeat(63_970)}` };
      const note = `OWNER_NOTE_${round}:${'n'.repeat(63_970)}`;
      ledger = ok(
        applyAgendaCommand(ledger, { action: 'answer', actor: HUMAN, id: 'A1', response, note, at: AT }),
      ).ledger;
      ledger = ok(
        applyAgendaCommand(ledger, {
          action: 'edit',
          actor: AGENT,
          id: 'A1',
          patch: { questionAnswer: `Round ${round}` },
          at: AT,
        }),
      ).ledger;
    }
    const reread = parseAgendaLedger(JSON.parse(agendaLedgerDocument(ledger)), SESSION_ID);
    should(reread).not.be.null();
    const saved = JSON.stringify(reread);
    for (let round = 1; round <= 23; round++) {
      should(saved).containEql(`OWNER_RESPONSE_${round}:`);
      should(saved).containEql(`OWNER_NOTE_${round}:`);
    }
    should(ledger.archivePending?.length ?? 0).be.above(0);
    should(agendaSnapshot(ledger)).not.have.property('archivePending');
  });

  it('should reserve the complete JSON envelope and keep large answers retryable and closable', () => {
    const ledger = heavyQuestionBoard();
    const response = { kind: 'open-question' as const, answer: 'a'.repeat(64_000) };
    const oversized = { action: 'resolve', id: 'A1', response, note: '\u0000'.repeat(64_000) };
    should(AgendaActionRequestSchema.safeParse(oversized).success).be.false();
    should(
      applyAgendaCommand(ledger, { ...oversized, action: 'answer', actor: HUMAN, at: AT } as Parameters<
        typeof applyAgendaCommand
      >[1]).ok,
    ).be.false();
    const answered = ok(
      applyAgendaCommand(ledger, {
        action: 'answer',
        actor: HUMAN,
        id: 'A1',
        response,
        note: 'n'.repeat(64_000),
        at: AT,
      }),
    );
    const failed = ok(
      applyAgendaCommand(answered.ledger, {
        action: 'undelivered',
        actor: { kind: 'daemon', cause: 'system' },
        id: 'A1',
        request: 1,
        reason: 'offline',
        at: AT,
      }),
    );
    const projected = open(failed.ledger).undelivered?.reply;
    if (projected?.action !== 'resolve' || projected.response === undefined) throw new Error('no Retry');
    const retried = ok(
      applyAgendaCommand(failed.ledger, {
        action: 'answer',
        actor: HUMAN,
        id: 'A1',
        response: projected.response,
        note: projected.note,
        at: AT,
      }),
    );
    should(open(retried.ledger).ownerAnswer?.response).deepEqual(response);
    should(open(retried.ledger).ownerAnswer?.note).equal('n'.repeat(64_000));
    const closed = ok(
      applyAgendaCommand(failed.ledger, {
        action: 'resolve',
        actor: HUMAN,
        id: 'A1',
        note: 'c'.repeat(64_000),
        at: AT,
      }),
    );
    for (const item of [answered.item, failed.item, retried.item, closed.addressed]) {
      should(JSON.stringify(item).length).be.belowOrEqual(MAX_AGENDA_ITEM_LENGTH);
    }
    should(ResolvedAgendaItemSchema.safeParse(closed.addressed).success).be.true();
    const escaped = ok(
      applyAgendaCommand(ledger, {
        action: 'answer',
        actor: HUMAN,
        id: 'A1',
        response,
        note: '\u0000'.repeat(11_000),
        at: AT,
      }),
    );
    const retryEscaped = ok(
      applyAgendaCommand(escaped.ledger, {
        action: 'undelivered',
        actor: { kind: 'daemon', cause: 'system' },
        id: 'A1',
        request: 1,
        reason: 'offline',
        at: AT,
      }),
    );
    const closeEscaped = ok(
      applyAgendaCommand(retryEscaped.ledger, {
        action: 'resolve',
        actor: HUMAN,
        id: 'A1',
        note: 'c'.repeat(64_000),
        at: AT,
      }),
    );
    should(JSON.stringify(closeEscaped.addressed).length).be.belowOrEqual(MAX_AGENDA_ITEM_LENGTH);
  });

  it('should refuse a closed item whose resolution pushes the full JSON over the transport bound', () => {
    const answered = ok(
      applyAgendaCommand(heavyQuestionBoard(), {
        action: 'answer',
        actor: HUMAN,
        id: 'A1',
        response: { kind: 'open-question', answer: 'a'.repeat(64_000) },
        note: 'n'.repeat(64_000),
        at: AT,
      }),
    );
    const item = open(answered.ledger);
    // Fill retained versions to the wire bound without changing the content bound.
    const previous = { body: '' };
    const nearLimit = { ...item, revisions: [{ at: AT, by: 'agent', changed: ['body'], previous }] };
    previous.body = 'v'.repeat(MAX_AGENDA_ITEM_LENGTH - JSON.stringify(nearLimit).length - 1);
    should(AgendaItemSchema.safeParse(nearLimit).success).be.true();
    const raw = {
      ...nearLimit,
      resolvedAt: AT,
      disposition: 'done',
      resolvedBy: 'human',
      resolvedBySession: null,
      resolvedByName: null,
      resolutionNote: 'c'.repeat(64_000),
    };
    should(JSON.stringify(raw).length).be.above(MAX_AGENDA_ITEM_LENGTH);
    should(ResolvedAgendaItemSchema.safeParse(raw).success).be.false();
  });
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
