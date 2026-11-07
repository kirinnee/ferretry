import { describe, it } from 'bun:test';
import should from 'should';
import {
  AgendaActionRequestSchema,
  AgendaClearableFieldSchema,
  AGENDA_CHANNEL_HEADER,
  AGENDA_URGENT_WAKE_MS,
  AgendaItemSchema,
  AgendaParkedSchema,
  MAX_AGENDA_CONTENT_LENGTH,
  MAX_AGENDA_RESPONSE_LENGTH,
  ResolvedAgendaItemSchema,
  agendaBadgeCount,
  agendaWakeAt,
  readsAgendaHeaders,
  agendaBriefRequiredProblems,
  agendaNoticeProblems,
} from '../../../../daemon/lib/protocol/agenda.ts';
import { agendaTurn } from '../../../../daemon/lib/protocol/agenda-card.ts';

const AT = '2026-10-26T09:00:00.000Z';

const base = {
  subject: 'Pick a plan',
  why: 'Two plans fit.',
  howToResolve: 'Choose one.',
  ask: { kind: 'open-question' },
} as const;

const notice = {
  action: 'add',
  notice: true,
  subject: 'CI is green on main',
  why: 'The release branch builds again.',
  howToResolve: 'Nothing to do.',
} as const;

describe('AgendaClearableFieldSchema', () => {
  it('should name exactly the agenda fields an edit can take off an item', () => {
    // Assert
    should(AgendaClearableFieldSchema.options).deepEqual([
      'blockingNow',
      'willBlock',
      'neededBy',
      'questionAnswer',
      'decided',
      'stillOpen',
      'terms',
      'recommendation',
      'optionDetails',
      'impact',
      'urgency',
      'links',
      'whereWeAre',
      'body',
      'detail',
    ]);
    // A cold reader starts from these, and the ask's shape is replaced, never removed (docs/agenda.md § Patch).
    for (const field of ['title', 'subject', 'why', 'howToResolve', 'premise', 'context', 'kind', 'ask', 'steps', '']) {
      should(AgendaClearableFieldSchema.safeParse(field).success).be.false();
    }
  });
});

describe('the add request: agenda fields, notice, ping and the old surface flag', () => {
  it('should keep blockingNow, willBlock and neededBy', () => {
    // Act
    const add = AgendaActionRequestSchema.parse({
      action: 'add',
      ...base,
      blockingNow: true,
      willBlock: 'the deploy',
      neededBy: '2026-12-01T09:00:00.000Z',
    });

    // Assert
    should(add).containDeep({ blockingNow: true, willBlock: 'the deploy', neededBy: '2026-12-01T09:00:00.000Z' });
  });

  it('should refuse blockingNow that is not true, and a neededBy that is not an instant', () => {
    // Assert
    should(AgendaActionRequestSchema.safeParse({ action: 'add', ...base, blockingNow: false }).success).be.false();
    should(AgendaActionRequestSchema.safeParse({ action: 'add', ...base, neededBy: 'tomorrow' }).success).be.false();
  });

  it('should still accept the surface flag older CLIs send', () => {
    // Act
    const add = AgendaActionRequestSchema.safeParse({ action: 'add', ...base, surface: true });

    // Assert
    should(add.success).be.true();
  });

  it('should accept a notice, with or without a ping, and refuse a notice that is not true', () => {
    // Assert
    should(AgendaActionRequestSchema.parse(notice)).containDeep({ action: 'add', notice: true });
    should(AgendaActionRequestSchema.parse({ ...notice, ping: true })).containDeep({ notice: true, ping: true });
    should(AgendaActionRequestSchema.safeParse({ ...notice, notice: false }).success).be.false();
    should(AgendaActionRequestSchema.safeParse({ ...notice, ping: false }).success).be.false();
  });

  it('should refuse a notice that carries an ask, answers, steps or a kind other than info', () => {
    // Act
    const refused = (extra: Record<string, unknown>) => AgendaActionRequestSchema.safeParse({ ...notice, ...extra });

    // Assert
    should(refused({ ask: { kind: 'open-question' } }).success).be.false();
    should(refused({ answers: [{ label: 'ok' }] }).success).be.false();
    should(refused({ steps: ['Run it'] }).success).be.false();
    should(refused({ kind: 'task' }).success).be.false();
    should(refused({ kind: 'info' }).success).be.true();
  });

  it('should refuse a ping that is not on a notice, and say why', () => {
    // Act
    const result = AgendaActionRequestSchema.safeParse({ action: 'add', ...base, ping: true });

    // Assert
    should(result.success).be.false();
    should(result.error?.issues.map(issue => issue.message)).containEql('ping is only for a notice');
  });

  it('should refuse a key the request does not know', () => {
    // Assert
    should(AgendaActionRequestSchema.safeParse({ action: 'add', ...base, urgentNow: true }).success).be.false();
  });
});

describe('the edit request: back', () => {
  it('should accept back: true, so a ferret can bring a replied item back to the owner', () => {
    // Act
    const parsed = AgendaActionRequestSchema.parse({ action: 'edit', id: 'A1', subject: 'Which region?', back: true });

    // Assert
    should(parsed).containDeep({ action: 'edit', id: 'A1', back: true });
  });

  it('should refuse back: false, which would mean nothing', () => {
    // Act + Assert
    should(
      AgendaActionRequestSchema.safeParse({ action: 'edit', id: 'A1', subject: 's', back: false }).success,
    ).be.false();
  });
});

describe('the edit request: clear', () => {
  it('should accept one to three distinct-field clears, with or without other changes', () => {
    // Assert
    should(AgendaActionRequestSchema.parse({ action: 'edit', id: 'A1', clear: ['neededBy'] })).containDeep({
      clear: ['neededBy'],
    });
    should(
      AgendaActionRequestSchema.parse({
        action: 'edit',
        id: 'A1',
        willBlock: 'the release',
        clear: ['blockingNow', 'neededBy'],
      }),
    ).containDeep({ willBlock: 'the release', clear: ['blockingNow', 'neededBy'] });
  });

  it('should refuse an empty clear list, an unknown field and a field named twice', () => {
    // Assert
    should(AgendaActionRequestSchema.safeParse({ action: 'edit', id: 'A1', clear: [] }).success).be.false();
    should(AgendaActionRequestSchema.safeParse({ action: 'edit', id: 'A1', clear: ['title'] }).success).be.false();
    should(
      AgendaActionRequestSchema.safeParse({
        action: 'edit',
        id: 'A1',
        clear: ['blockingNow', 'willBlock', 'neededBy', 'blockingNow'],
      }).success,
    ).be.false();
  });

  it('should refuse a field set and cleared in the same edit, naming it', () => {
    // Act
    const both = AgendaActionRequestSchema.safeParse({
      action: 'edit',
      id: 'A1',
      neededBy: '2026-12-01T09:00:00.000Z',
      clear: ['neededBy'],
    });
    const blocking = AgendaActionRequestSchema.safeParse({
      action: 'edit',
      id: 'A1',
      blockingNow: true,
      clear: ['blockingNow'],
    });

    // Assert
    should(both.success).be.false();
    should(both.error?.issues.map(issue => issue.message)).containEql('neededBy cannot be set and cleared at once');
    should(blocking.success).be.false();
  });

  it('should refuse a key the edit does not know, and a notice flag on an edit', () => {
    // Assert
    should(AgendaActionRequestSchema.safeParse({ action: 'edit', id: 'A1', clearAll: true }).success).be.false();
    should(AgendaActionRequestSchema.safeParse({ action: 'edit', id: 'A1', notice: true }).success).be.false();
  });
});

describe('agendaBriefRequiredProblems', () => {
  it('should find nothing missing when both are given, or on a notice', () => {
    // Assert
    should(agendaBriefRequiredProblems({ premise: 'A deploy waits', context: 'It ships at 14:00' })).deepEqual([]);
    should(agendaBriefRequiredProblems({ notice: true })).deepEqual([]);
  });

  it('should name each missing field, premise first, and count a blank or null one as missing', () => {
    // Assert
    should(agendaBriefRequiredProblems({})).deepEqual([
      'premise (--premise) is required: the situation, what is going on',
      'context (--context) is required: the facts around it',
    ]);
    should(agendaBriefRequiredProblems({ premise: '  ', context: 'Why' })).deepEqual([
      'premise (--premise) is required: the situation, what is going on',
    ]);
    should(agendaBriefRequiredProblems({ premise: 'What', context: null })).deepEqual([
      'context (--context) is required: the facts around it',
    ]);
  });
});

describe('agendaNoticeProblems', () => {
  it('should find nothing wrong with a plain raise, a bare notice or a notice of kind info', () => {
    // Assert
    should(agendaNoticeProblems({ ask: { kind: 'open-question' }, kind: 'task' })).deepEqual([]);
    should(agendaNoticeProblems({ notice: true })).deepEqual([]);
    should(agendaNoticeProblems({ notice: true, ping: true, kind: 'info' })).deepEqual([]);
  });

  it('should say each thing a notice cannot carry, in a fixed order', () => {
    // Act
    const problems = agendaNoticeProblems({
      notice: true,
      ask: {},
      answers: [],
      steps: [],
      kind: 'task',
    });

    // Assert
    should(problems).deepEqual([
      'a notice has no ask',
      'a notice has no answers',
      'a notice has no steps: it is read, not done',
      'a notice is kind info',
    ]);
  });

  it('should refuse a ping only when the raise is not a notice', () => {
    // Assert
    should(agendaNoticeProblems({ ping: true })).deepEqual(['ping is only for a notice']);
    should(agendaNoticeProblems({ notice: true, ping: true })).deepEqual([]);
  });
});

describe('agendaTurn', () => {
  it('should be the owner’s turn for an open item, the ferret’s once it waits on the ferret, done once resolved', () => {
    // Assert
    should(agendaTurn({})).equal('owner');
    should(agendaTurn({ waitingOn: 'ferret' })).equal('ferret');
    should(agendaTurn({ resolvedAt: AT })).equal('done');
    should(agendaTurn({ waitingOn: 'ferret', resolvedAt: AT })).equal('done');
  });

  it('should never give a notice a turn, however it is marked', () => {
    // Assert
    should(agendaTurn({ notice: true })).equal('done');
    should(agendaTurn({ notice: true, waitingOn: 'ferret' })).equal('done');
  });
});

describe('an item that is a notice', () => {
  it('should read back with its notice and ping marks', () => {
    // Act
    const item = AgendaItemSchema.parse({
      id: 'A1',
      source: 'agent-raised',
      sourceRef: null,
      subject: 'CI is green on main',
      why: 'The release branch builds again.',
      waitingSince: AT,
      howToResolve: 'Nothing to do.',
      notice: true,
      ping: true,
      raisedBy: 'agent',
      raisedBySession: 'session-1',
      raisedByName: null,
    });

    // Assert
    should(item).containDeep({ notice: true, ping: true });
  });
});

describe('AgendaParkedSchema', () => {
  const LATER = '2026-10-27T09:00:00.000Z';

  it('should read a snoozed park with its wake time and a replied park without one', () => {
    // Assert
    should(AgendaParkedSchema.parse({ reason: 'snoozed', at: AT, until: LATER })).deepEqual({
      reason: 'snoozed',
      at: AT,
      until: LATER,
    });
    should(AgendaParkedSchema.parse({ reason: 'replied', at: AT })).deepEqual({ reason: 'replied', at: AT });
  });

  it('should refuse a snooze with no wake time, a reply with one, and any other reason', () => {
    // Assert
    should(AgendaParkedSchema.safeParse({ reason: 'snoozed', at: AT }).success).be.false();
    should(AgendaParkedSchema.safeParse({ reason: 'replied', at: AT, until: LATER }).success).be.false();
    should(AgendaParkedSchema.safeParse({ reason: 'later', at: AT }).success).be.false();
  });

  it('should ride on an item with the instant a ferret last woke it as urgent', () => {
    // Act
    const item = AgendaItemSchema.parse({
      id: 'A1',
      source: 'agent-raised',
      sourceRef: null,
      subject: 'Pick a plan',
      why: 'Two plans fit.',
      waitingSince: AT,
      howToResolve: 'Choose one.',
      raisedBy: 'agent',
      raisedBySession: 'session-1',
      raisedByName: 'Olivier',
      parked: { reason: 'snoozed', at: AT, until: LATER },
      urgentAt: AT,
    });

    // Assert
    should(item).containDeep({ parked: { reason: 'snoozed', until: LATER }, urgentAt: AT });
  });
});

describe('agendaBadgeCount', () => {
  it('should count the open items that wait on someone, leaving parked ones out', () => {
    const at = '2026-10-30T10:00:00.000Z';
    should(agendaBadgeCount({ items: [] })).equal(0);
    should(
      agendaBadgeCount({
        items: [{}, { parked: { reason: 'replied', at } }, { parked: { reason: 'snoozed', at, until: at } }, {}],
      }),
    ).equal(2);
  });
});

describe('agendaWakeAt', () => {
  const until = '2026-10-27T09:00:00.000Z';
  const snoozed = { reason: 'snoozed', at: AT, until } as const;

  it('should be the snooze time when nothing is needed sooner, or by when', () => {
    // Assert
    should(agendaWakeAt({ parked: snoozed })).equal(until);
    should(agendaWakeAt({ parked: snoozed, neededBy: '2026-10-28T09:00:00.000Z' })).equal(until);
    should(agendaWakeAt({ parked: snoozed, neededBy: until })).equal(until);
  });

  it('should be the deadline when it comes before the snooze ends', () => {
    // Assert
    should(agendaWakeAt({ parked: snoozed, neededBy: '2026-10-26T12:00:00.000Z' })).equal('2026-10-26T12:00:00.000Z');
  });

  it('should be null for an item that is not snoozed', () => {
    // Assert
    should(agendaWakeAt({})).be.null();
    should(agendaWakeAt({ neededBy: until })).be.null();
    should(agendaWakeAt({ parked: { reason: 'replied', at: AT }, neededBy: until })).be.null();
  });

  it('should let a ferret wake a snoozed item as urgent once an hour', () => {
    // Assert
    should(AGENDA_URGENT_WAKE_MS).equal(3_600_000);
  });
});

describe('parked turns and requests', () => {
  it('should give a parked open item to nobody, unless it is a notice or resolved', () => {
    // Assert
    should(agendaTurn({ parked: { reason: 'replied' } })).equal('parked');
    should(agendaTurn({ parked: { reason: 'snoozed' }, waitingOn: 'ferret' })).equal('parked');
    should(agendaTurn({ parked: { reason: 'replied' }, notice: true })).equal('done');
    should(agendaTurn({ parked: { reason: 'replied' }, resolvedAt: AT })).equal('done');
  });

  it('should read snooze, unsnooze, and `now` on an edit or a surface', () => {
    // Assert
    should(AgendaActionRequestSchema.parse({ action: 'snooze', id: 'A1', until: AT })).deepEqual({
      action: 'snooze',
      id: 'A1',
      until: AT,
    });
    should(AgendaActionRequestSchema.parse({ action: 'unsnooze', id: 'A1' })).deepEqual({
      action: 'unsnooze',
      id: 'A1',
    });
    should(AgendaActionRequestSchema.parse({ action: 'edit', id: 'A1', subject: 'x', now: true })).containDeep({
      now: true,
    });
    should(AgendaActionRequestSchema.parse({ action: 'surface', id: 'A1', now: true })).containDeep({ now: true });
  });

  it('should refuse a snooze with no time, a `now` that is not true, and a stray field', () => {
    // Assert
    should(AgendaActionRequestSchema.safeParse({ action: 'snooze', id: 'A1' }).success).be.false();
    should(AgendaActionRequestSchema.safeParse({ action: 'snooze', id: 'A1', until: 'tomorrow' }).success).be.false();
    should(AgendaActionRequestSchema.safeParse({ action: 'surface', id: 'A1', now: false }).success).be.false();
    should(AgendaActionRequestSchema.safeParse({ action: 'unsnooze', id: 'A1', until: AT }).success).be.false();
  });
});

const boundedItem = {
  id: 'A1',
  source: 'agent-raised',
  sourceRef: null,
  subject: 'Approve the plan',
  why: 'Approve the plan',
  waitingSince: AT,
  howToResolve: 'Answer this item on the agenda board.',
  ask: { kind: 'open-question' },
  raisedBy: 'agent',
  raisedBySession: 'session-1',
  raisedByName: 'Olivier',
} as const;

describe('the bounds of an owner response', () => {
  it('should refuse a response over its bound and accept one at it', () => {
    // Arrange
    const over = {
      ...boundedItem,
      resolvedAt: AT,
      disposition: 'done',
      resolutionNote: null,
      resolvedBy: 'human',
      resolvedBySession: null,
      resolvedByName: null,
    };

    // Act
    const refused = ResolvedAgendaItemSchema.safeParse({
      ...over,
      response: { kind: 'open-question', answer: 'a'.repeat(MAX_AGENDA_RESPONSE_LENGTH + 1) },
    });

    // Assert
    should(refused.success).equal(false);
    should(MAX_AGENDA_CONTENT_LENGTH).be.above(MAX_AGENDA_RESPONSE_LENGTH);
  });
});

it('sheds oldest history when it crowds the transport bound, retaining gate receipts', async () => {
  const { fitAgendaItem, MAX_AGENDA_ITEM_LENGTH } = await import('../../../../daemon/lib/protocol/agenda.ts');
  const item = {
    body: 'b'.repeat(MAX_AGENDA_ITEM_LENGTH - 100),
    history: [
      { kind: 'replied', note: 'r'.repeat(500) },
      { kind: 'gate-answered', note: 'gate:F12' },
    ],
  };
  const fitted = fitAgendaItem(item);
  should(fitted.history).deepEqual([{ kind: 'gate-answered', note: 'gate:F12' }]);
  should(JSON.stringify(fitted).length).be.below(MAX_AGENDA_ITEM_LENGTH);
});

describe('reading resolved agenda headers', () => {
  it('requires channel 2 explicitly', () => {
    for (const value of ['2', ' 2 '])
      should(readsAgendaHeaders(new Headers({ [AGENDA_CHANNEL_HEADER]: value }))).equal(true);
    for (const value of ['', '1', '3'])
      should(readsAgendaHeaders(new Headers({ [AGENDA_CHANNEL_HEADER]: value }))).equal(false);
    should(readsAgendaHeaders(new Headers())).equal(false);
  });
});
