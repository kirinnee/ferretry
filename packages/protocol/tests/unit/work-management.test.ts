import { describe, it } from 'bun:test';
import should from 'should';
import * as agenda from '../../src/lib/agenda.ts';
import * as pins from '../../src/lib/pins.ts';
import { INSTANT, LATER_INSTANT } from '../fixtures.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

const permissionAsk = { kind: 'permission' };
const agendaItem = {
  id: 'A1',
  source: 'agent-raised',
  sourceRef: null,
  subject: 'Approval needed',
  why: 'The operation is destructive.',
  context: null,
  waitingSince: INSTANT,
  howToResolve: 'Approve or reject it.',
  ask: permissionAsk,
  raisedBy: 'agent',
  raisedBySession: 'session-1',
  raisedByName: 'Ada',
};
const resolvedAgenda = {
  ...agendaItem,
  resolvedAt: LATER_INSTANT,
  resolvedBy: 'human',
  resolvedBySession: null,
  resolvedByName: null,
  resolutionNote: null,
  response: { kind: 'permission', decision: 'approve' },
  disposition: 'done',
};
const resolvedAgendaHeader = {
  projection: 'header',
  lifecycle: 'addressed',
  id: 'A2',
  title: 'Approval granted',
  kind: 'permission',
  subject: agendaItem.subject,
  why: agendaItem.why,
  sourceRef: agendaItem.sourceRef,
  raisedBy: agendaItem.raisedBy,
  raisedByName: agendaItem.raisedByName,
  conversationCount: 3,
  resolvedAt: resolvedAgenda.resolvedAt,
  resolvedBy: resolvedAgenda.resolvedBy,
  resolvedBySession: resolvedAgenda.resolvedBySession,
  resolvedByName: resolvedAgenda.resolvedByName,
  resolutionNote: resolvedAgenda.resolutionNote,
  disposition: resolvedAgenda.disposition,
};
const agendaListSnapshot = {
  v: 1,
  sessionId: 'session-1',
  items: [agendaItem],
  resolved: [resolvedAgendaHeader, { ...resolvedAgenda, id: 'A3' }],
  count: 1,
  parseErrors: 0,
  updatedAt: LATER_INSTANT,
};

const agendaCases: SchemaCase[] = [
  {
    name: 'edit request with a revision (agenda.patch.1)',
    schema: agenda.AgendaEditRequestSchema,
    value: { action: 'edit', id: 'A1', revision: '1kvr35710qfik6', why: 'Ship it this week?', clear: ['detail'] },
  },
  { name: 'attention source', schema: agenda.AgendaSourceSchema, value: 'agent-raised' },
  { name: 'card kind', schema: agenda.AgendaKindSchema, value: 'yesno' },
  { name: 'swipe direction', schema: agenda.AgendaDirectionSchema, value: 'up' },
  { name: 'revisable field', schema: agenda.AgendaRevisableFieldSchema, value: 'stillOpen' },
  {
    name: 'revision',
    schema: agenda.AgendaRevisionSchema,
    value: {
      at: '2026-05-01T10:00:00.000Z',
      by: 'agent',
      changed: ['decided', 'stillOpen'],
      previous: { stillOpen: '- who signs' },
    },
  },
  { name: 'answer effect', schema: agenda.AgendaAnswerEffectSchema, value: 'needs-info' },
  {
    name: 'card answer',
    schema: agenda.AgendaCardAnswerSchema,
    value: { direction: 'up', does: 'approve', label: 'Always allow', description: 'Stop asking for this command' },
  },
  {
    name: 'ask option',
    schema: agenda.AgendaAskOptionSchema,
    value: { label: 'Proceed', description: 'Run the operation' },
  },
  { name: 'form field type', schema: agenda.AgendaFieldTypeSchema, value: 'many' },
  {
    name: 'form field',
    schema: agenda.AgendaFormFieldSchema,
    value: {
      id: 'region',
      type: 'one',
      label: 'Which region?',
      name: 'Region',
      options: [{ label: 'EU', description: 'data stays in Europe' }, { label: 'US' }],
      recommended: ['EU'],
      required: true,
    },
  },
  { name: 'form answer', schema: agenda.AgendaFormAnswerSchema, value: { id: 'alerts', picked: ['Page', 'Mail'] } },
  { name: 'tab', schema: agenda.AgendaTabSchema, value: { id: 'risks', name: 'Risks', body: 'The export may slip.' } },
  { name: 'tab edit', schema: agenda.AgendaTabEditSchema, value: { tab: 'Risks', rename: 'Open risks', position: 1 } },
  {
    name: 'brief term',
    schema: agenda.AgendaTermSchema,
    value: { term: 'OCI', meaning: 'Oracle Cloud Infrastructure' },
  },
  {
    name: 'option detail',
    schema: agenda.AgendaOptionDetailSchema,
    value: { label: 'Use SQLite', detail: 'One file, **no server**. Set `journal_mode=WAL`.' },
  },
  {
    name: 'brief question',
    schema: agenda.AgendaQuestionSchema,
    value: {
      question: 'Which plan?',
      options: [{ label: 'Defaults' }, { label: 'Changes' }],
      recommended: 'Defaults',
      why: 'It runs today',
    },
  },
  {
    name: 'brief recommendation',
    schema: agenda.AgendaRecommendationSchema,
    value: { decision: 'Ship on Thursday', why: 'Nobody is on call on Friday' },
  },
  { name: 'brief link', schema: agenda.AgendaLinkSchema, value: { label: 'Plan', target: '#F12' } },
  { name: 'attention ask', schema: agenda.AgendaAskSchema, value: permissionAsk },
  { name: 'to-do ask', schema: agenda.AgendaAskSchema, value: { kind: 'task' } },
  {
    name: 'attention history entry',
    schema: agenda.AgendaHistoryEntrySchema,
    value: { at: INSTANT, kind: 'needs-info', note: 'Which account?' },
  },
  {
    name: 'item waiting on the ferret',
    schema: agenda.AgendaItemSchema,
    value: {
      ...agendaItem,
      ask: { kind: 'task' },
      waitingOn: 'ferret',
      askedAt: LATER_INSTANT,
      infoRequests: 1,
      history: [{ at: LATER_INSTANT, kind: 'needs-info' }],
    },
  },
  {
    name: 'needs-info action',
    schema: agenda.AgendaActionRequestSchema,
    value: { action: 'needs-info', id: 'A1', note: 'Which account?' },
  },
  {
    name: 'needs-info action without a note',
    schema: agenda.AgendaActionRequestSchema,
    value: { action: 'needs-info', id: 'A1' },
  },
  {
    name: 'attention response',
    schema: agenda.AgendaResponseSchema,
    value: { kind: 'permission', decision: 'approve' },
  },
  { name: 'disposition', schema: agenda.AgendaDispositionSchema, value: 'done' },
  {
    name: 'snoozed park',
    schema: agenda.AgendaParkedSchema,
    value: { reason: 'snoozed', at: INSTANT, until: LATER_INSTANT },
  },
  { name: 'replied park', schema: agenda.AgendaParkedSchema, value: { reason: 'replied', at: INSTANT } },
  {
    name: 'owner answer on an open item',
    schema: agenda.AgendaOwnerAnswerSchema,
    value: { at: INSTANT, response: { kind: 'open-question', answer: 'EU' }, note: 'keep it near', request: 2 },
  },
  { name: 'attention id', schema: agenda.AgendaIdSchema, value: 'A1' },
  { name: 'attention actor', schema: agenda.AgendaBySchema, value: 'agent' },
  { name: 'attention item', schema: agenda.AgendaItemSchema, value: agendaItem },
  { name: 'stored attention item', schema: agenda.StoredAgendaItemSchema, value: agendaItem },
  { name: 'agenda query', schema: agenda.AgendaOpenQuerySchema, value: { after: 'session-1', limit: 50 } },
  {
    name: 'agenda roll-up session',
    schema: agenda.AgendaOpenSessionSchema,
    value: { sessionId: 'session-1', items: [agendaItem] },
  },
  {
    name: 'agenda roll-up page',
    schema: agenda.AgendaOpenPageSchema,
    value: { sessions: [{ sessionId: 'session-1', items: [agendaItem] }], next: 'session-1' },
  },
  { name: 'attention input pointer', schema: agenda.AgendaInputRefSchema, value: { requestId: 'a'.repeat(32) } },
  { name: 'gate outcome', schema: agenda.AgendaGateOutcomeSchema, value: 'reopen-with-agenda' },
  {
    name: 'gate option',
    schema: agenda.AgendaGateOptionSchema,
    value: { id: 'done', label: 'Done', outcome: 'close' },
  },
  {
    name: 'gate',
    schema: agenda.AgendaGateSchema,
    value: {
      cardId: 'F412',
      laneId: 'released',
      laneName: 'Released · to test',
      entry: 7,
      projectId: 'p-1',
      projectName: 'Ferretry',
      options: [{ id: 'done', label: 'Done', outcome: 'close' }],
    },
  },
  {
    name: 'card ask answer',
    schema: agenda.AgendaCardAskAnswerSchema,
    value: {
      at: '2026-07-30T10:00:00.000Z',
      response: { kind: 'multiple-choice', choice: 'Done' },
      note: 'works for me',
      receipt: 'd'.repeat(64),
      askVersion: 2,
    },
  },
  {
    name: 'card ask woke',
    schema: agenda.AgendaCardAskWokeSchema,
    value: {
      waitingSince: '2026-07-30T09:00:00.000Z',
      parked: { reason: 'replied', at: '2026-07-30T09:00:00.000Z' },
      resting: { sub: 'waiting-on-ferret', at: '2026-07-30T09:00:00.000Z' },
    },
  },
  {
    name: 'card ask',
    schema: agenda.AgendaCardAskSchema,
    value: {
      gate: {
        cardId: 'F412',
        laneId: 'released',
        laneName: 'Released',
        entry: 7,
        projectId: 'p-1',
        options: [{ id: 'done', label: 'Done', outcome: 'close' }],
      },
      at: '2026-07-30T10:00:00.000Z',
      howToTest: 'Open the app and add a card.',
      notYet: { at: '2026-07-30T11:00:00.000Z', note: 'tomorrow' },
    },
  },
  { name: 'attention paste plan pointer', schema: agenda.AgendaCopyPlanRefSchema, value: { planId: 'b'.repeat(32) } },
  { name: 'attention task plan pointer', schema: agenda.AgendaTaskPlanRefSchema, value: { planId: 'c'.repeat(32) } },
  {
    name: 'attention phone approval pointer',
    schema: agenda.AgendaPhoneApprovalRefSchema,
    value: { id: `pa_${'0'.repeat(23)}1` },
  },
  {
    name: 'attention 2FA seed pointer',
    schema: agenda.AgendaTwoFactorSeedRefSchema,
    value: { stage: `st_${'a'.repeat(24)}`, account: 'GITHUB' },
  },
  {
    name: 'attention standing rule suggestion pointer',
    schema: agenda.AgendaSignInRuleSuggestionRefSchema,
    value: { suggestion: `srg_${'a'.repeat(16)}` },
  },
  {
    name: 'attention suspended standing rule pointer',
    schema: agenda.AgendaSignInRuleSuspendedRefSchema,
    value: { rule: `sr_${'b'.repeat(24)}` },
  },
  { name: 'resolved attention', schema: agenda.ResolvedAgendaItemSchema, value: resolvedAgenda },
  { name: 'stored resolved attention', schema: agenda.StoredResolvedAgendaItemSchema, value: resolvedAgenda },
  { name: 'resolved attention header', schema: agenda.ResolvedAgendaHeaderSchema, value: resolvedAgendaHeader },
  { name: 'header list record', schema: agenda.AgendaListRecordSchema, value: resolvedAgendaHeader },
  { name: 'full list record', schema: agenda.AgendaListRecordSchema, value: resolvedAgenda },
  { name: 'mixed attention list', schema: agenda.AgendaListSnapshotSchema, value: agendaListSnapshot },
  { name: 'open one-item read', schema: agenda.AgendaReadItemSchema, value: agendaItem },
  { name: 'resolved one-item read', schema: agenda.AgendaReadItemSchema, value: resolvedAgenda },
  {
    name: 'card a notice is about',
    schema: agenda.AgendaCardRowSchema,
    value: {
      task: { id: 'F1' },
      line: '&F1 Fix it is waiting in Review/CI, but no ferret is assigned, so nothing will happen to it.',
    },
  },
  {
    name: 'session attention summary',
    schema: agenda.SessionAgendaSummarySchema,
    value: { open: 2, first: 'A1', ask: 'Rebase onto main now?', latestAt: '2026-10-23T10:00:00.000Z' },
  },
  {
    name: 'held attention replies',
    schema: agenda.AgendaRepliesSchema,
    value: { pending: ['A1', 'A3'], dueAt: INSTANT },
  },
  {
    name: 'agenda answers on their way',
    schema: agenda.AgendaDeliverySchema,
    value: { sending: ['A2'], heldForComposer: true },
  },
  {
    name: 'an agenda field an edit can clear',
    schema: agenda.AgendaClearableFieldSchema,
    value: 'neededBy',
  },
  {
    name: 'an undelivered retry',
    schema: agenda.AgendaUndeliveredReplySchema,
    value: { action: 'discuss', note: 'The premise is wrong' },
  },
  {
    name: 'a held configuration change an item confirms',
    schema: agenda.AgendaConfirmsSchema,
    value: {
      path: 'warden.yaml',
      etag: 'a'.repeat(64),
      changes: ['the Jev price the cap counts with goes down from 2 to 0.042'],
      restated: true,
    },
  },
  {
    name: 'an undelivered answer',
    schema: agenda.AgendaUndeliveredSchema,
    value: {
      at: INSTANT,
      reply: { action: 'resolve', response: { kind: 'permission', decision: 'approve' } },
      reason: 'it never appeared in the ferret’s transcript',
    },
  },
  {
    name: 'attention snapshot',
    schema: agenda.AgendaSnapshotSchema,
    value: {
      v: 1,
      sessionId: 'session-1',
      items: [agendaItem],
      resolved: [],
      count: 1,
      parseErrors: 0,
      updatedAt: INSTANT,
    },
  },
  {
    name: 'attention action',
    schema: agenda.AgendaActionRequestSchema,
    value: {
      action: 'add',
      source: 'agent-raised',
      sourceRef: null,
      subject: 'Need input',
      why: 'Blocked',
      howToResolve: 'Reply',
    },
  },
  {
    name: 'conversation entry',
    schema: agenda.AgendaConversationEntrySchema,
    value: {
      at: '2026-05-01T10:00:00.000Z',
      by: 'owner',
      text: 'use eu-west',
      via: 'chat-log',
      fromChat: { messageId: 'm1', at: '2026-05-01T09:59:00.000Z' },
    },
  },
  {
    name: 'split item',
    schema: agenda.SplitAgendaItemSchema,
    value: { subject: 'Another ask', why: 'It grew', howToResolve: 'Reply' },
  },
  {
    name: 'direct notification',
    schema: agenda.DirectNotificationRequestSchema,
    value: { body: 'Finished', title: 'Complete', kind: 'completed' },
  },
  {
    name: 'attention count',
    schema: agenda.AgendaCountResponseSchema,
    value: { sessionId: 'session-1', count: 1 },
  },
  {
    name: 'notification response',
    schema: agenda.DirectNotificationResponseSchema,
    value: { sessionId: 'session-1', delivered: 1 },
  },
  { name: 'attention error', schema: agenda.AgendaErrorCodeSchema, value: 'invalid' },
  { name: 'clear-agents request', schema: agenda.AgendaClearAgentsRequestSchema, value: { dryRun: true } },
  { name: 'clear-agents result', schema: agenda.AgendaClearAgentsResultSchema, value: { cleared: 4, sessions: 2 } },
];

const messagePin = {
  id: '11111111-1111-4111-8111-111111111111',
  at: 1,
  by: 'human',
  createdBy: null,
  createdByName: null,
  kind: 'message',
  blockId: 'block-1',
  blockKind: 'assistant',
  preview: 'A useful answer',
};
const notePin = {
  id: '22222222-2222-4222-8222-222222222222',
  at: 2,
  by: 'agent',
  createdBy: 'session-1',
  createdByName: 'Ada',
  kind: 'note',
  text: 'Remember this.',
};

const pinCases: SchemaCase[] = [
  { name: 'pin actor', schema: pins.PinBySchema, value: 'human' },
  { name: 'pin block kind', schema: pins.PinBlockKindSchema, value: 'assistant' },
  { name: 'message pin', schema: pins.MessagePinSchema, value: messagePin },
  { name: 'note pin', schema: pins.NotePinSchema, value: notePin },
  { name: 'pin', schema: pins.PinSchema, value: messagePin },
  {
    name: 'pin snapshot',
    schema: pins.PinSnapshotSchema,
    value: { v: 1, sessionId: 'session-1', pins: [messagePin, notePin], updatedAt: INSTANT },
  },
  { name: 'pin action', schema: pins.PinActionRequestSchema, value: { action: 'add', kind: 'note', text: 'Note' } },
  { name: 'pin error', schema: pins.PinErrorCodeSchema, value: 'invalid' },
];

describe('attention schemas', () => {
  it('should round-trip every public attention schema', () => {
    // Arrange
    const cases = agendaCases;

    // Act + Assert
    assertRoundTrips(cases);
    assertCoversEverySchema(agenda, cases);
  });

  it('should reject invalid list projections and incomplete one-item reads', () => {
    // Arrange
    const cases: SchemaCase[] = [
      {
        name: 'header with the wrong lifecycle',
        schema: agenda.ResolvedAgendaHeaderSchema,
        value: { ...resolvedAgendaHeader, lifecycle: 'open' },
      },
      { name: 'open item in resolved list', schema: agenda.AgendaListRecordSchema, value: agendaItem },
      {
        name: 'list count mismatch',
        schema: agenda.AgendaListSnapshotSchema,
        value: { ...agendaListSnapshot, count: 0 },
      },
      {
        name: 'duplicate resolved headers',
        schema: agenda.AgendaListSnapshotSchema,
        value: { ...agendaListSnapshot, resolved: [resolvedAgendaHeader, resolvedAgendaHeader] },
      },
      { name: 'header in one-item read', schema: agenda.AgendaReadItemSchema, value: resolvedAgendaHeader },
    ];

    // Act + Assert
    assertRejects(cases);
  });

  it('should refuse a standing rule pointer that is not exactly its own id', () => {
    // Arrange — a pointer names its suggestion or rule by id, and nothing else: never an account
    const suggestion = { suggestion: `srg_${'a'.repeat(16)}` };
    const suspended = { rule: `sr_${'b'.repeat(24)}` };
    const cases: SchemaCase[] = [
      {
        name: 'suggestion with an extra key',
        schema: agenda.AgendaSignInRuleSuggestionRefSchema,
        value: { ...suggestion, account: 'GITHUB' },
      },
      {
        name: 'suggestion id too short',
        schema: agenda.AgendaSignInRuleSuggestionRefSchema,
        value: { suggestion: 'srg_x' },
      },
      {
        name: 'suggestion named by a rule id',
        schema: agenda.AgendaSignInRuleSuggestionRefSchema,
        value: { suggestion: suspended.rule },
      },
      { name: 'empty suggestion pointer', schema: agenda.AgendaSignInRuleSuggestionRefSchema, value: {} },
      {
        name: 'suspended with an extra key',
        schema: agenda.AgendaSignInRuleSuspendedRefSchema,
        value: { ...suspended, account: 'GITHUB' },
      },
      {
        name: 'suspended named by a stage',
        schema: agenda.AgendaSignInRuleSuspendedRefSchema,
        value: { rule: `srs_${'b'.repeat(24)}` },
      },
      {
        name: 'suspended named by a suggestion',
        schema: agenda.AgendaSignInRuleSuspendedRefSchema,
        value: { rule: suggestion.suggestion },
      },
      { name: 'empty suspended pointer', schema: agenda.AgendaSignInRuleSuspendedRefSchema, value: {} },
    ];

    // Act + Assert
    assertRejects(cases);
  });

  it('should refuse a malformed gate, and a gate on an item the daemon did not raise', () => {
    // Arrange
    const option = { id: 'done', label: 'Done', outcome: 'close' };
    const gate = {
      cardId: 'F412',
      laneId: 'released',
      laneName: 'Released',
      entry: 7,
      projectId: 'p-1',
      options: [option],
    };
    const cases: SchemaCase[] = [
      { name: 'unknown outcome', schema: agenda.AgendaGateOutcomeSchema, value: 'archive' },
      { name: 'option with an extra key', schema: agenda.AgendaGateOptionSchema, value: { ...option, hint: 'x' } },
      {
        name: 'option label too long',
        schema: agenda.AgendaGateOptionSchema,
        value: { ...option, label: 'x'.repeat(25) },
      },
      {
        name: 'option label over two lines',
        schema: agenda.AgendaGateOptionSchema,
        value: { ...option, label: 'a\nb' },
      },
      { name: 'gate without options', schema: agenda.AgendaGateSchema, value: { ...gate, options: [] } },
      { name: 'gate with a zero entry', schema: agenda.AgendaGateSchema, value: { ...gate, entry: 0 } },
      { name: 'gate with an extra key', schema: agenda.AgendaGateSchema, value: { ...gate, owner: 'x' } },
      {
        name: 'gate raised by an agent',
        schema: agenda.AgendaItemSchema,
        value: { ...agendaItem, raisedBy: 'agent', gate },
      },
    ];

    // Act + Assert
    assertRejects(cases);
  });

  it('should resolve every ask, response, provenance, and action member', () => {
    // Arrange
    const asks = [
      { kind: 'permission' },
      { kind: 'multiple-choice', options: [{ label: 'A' }, { label: 'B' }] },
      { kind: 'answer-review' },
      { kind: 'open-question' },
      { kind: 'task' },
    ];
    const responses = [
      { kind: 'permission', decision: 'reject' },
      { kind: 'multiple-choice', choice: 'A' },
      { kind: 'answer-review', verdict: 'good' },
      { kind: 'answer-review', verdict: 'clarify', clarification: 'More detail' },
      { kind: 'open-question', answer: 'Answer' },
    ];
    const actions = [
      {
        action: 'add',
        subject: 'Need input',
        why: 'Blocked',
        howToResolve: 'Reply',
      },
      { action: 'resolve', id: 'A1', note: 'resolved', response: { kind: 'permission', decision: 'approve' } },
      { action: 'dismiss', id: 'A1', note: 'obsolete' },
      {
        action: 'add',
        subject: 'Log in',
        why: 'Blocked',
        howToResolve: 'Follow the steps',
        steps: ['Run `fy login`'],
        body: '## Notes',
      },
      { action: 'progress', id: 'A1', step: 0, done: true },
      { action: 'needs-info', id: 'A1' },
      {
        action: 'add',
        notice: true,
        ping: true,
        subject: 'CI is green',
        why: 'The branch builds again.',
        howToResolve: 'Nothing to do.',
      },
      {
        action: 'add',
        subject: 'Approve the deploy',
        why: 'Blocked',
        howToResolve: 'Reply',
        blockingNow: true,
        willBlock: 'the release',
        neededBy: INSTANT,
      },
      { action: 'edit', id: 'A1', willBlock: 'the release', clear: ['blockingNow', 'neededBy'] },
    ];

    // Act + Assert
    // A waiting mark needs its time, and the history is bounded.
    should(agenda.AgendaItemSchema.safeParse({ ...agendaItem, waitingOn: 'ferret' }).success).be.false();
    // What the owner waits FOR exists only while they wait.
    should(agenda.AgendaItemSchema.safeParse({ ...agendaItem, waitingFor: 'discussion' }).success).be.false();
    should(
      agenda.AgendaItemSchema.safeParse({
        ...agendaItem,
        history: Array.from({ length: 21 }, () => ({ at: INSTANT, kind: 'updated' })),
      }).success,
    ).be.false();
    for (const value of asks) should(agenda.AgendaAskSchema.safeParse(value).success).be.true();
    for (const value of responses) should(agenda.AgendaResponseSchema.safeParse(value).success).be.true();
    for (const raisedBy of ['human', 'daemon'] as const) {
      should(
        agenda.AgendaItemSchema.safeParse({
          ...agendaItem,
          raisedBy,
          raisedBySession: null,
          raisedByName: null,
        }).success,
      ).be.true();
    }
    for (const resolvedBy of ['agent', 'daemon'] as const) {
      should(
        agenda.ResolvedAgendaItemSchema.safeParse({
          ...resolvedAgenda,
          resolvedBy,
          resolvedBySession: resolvedBy === 'agent' ? 'session-2' : null,
          resolvedByName: resolvedBy === 'agent' ? 'Grace' : null,
        }).success,
      ).be.true();
    }
    for (const value of actions) should(agenda.AgendaActionRequestSchema.safeParse(value).success).be.true();
  });

  it('should accept an other answer on a resolved item whose ask offers options, and no other', () => {
    // Arrange
    const other = { kind: 'other', answer: 'neither, rewrite it' };
    const withAsk = (ask: unknown) => ({ ...resolvedAgenda, ask, response: other });

    // Act / Assert
    for (const ask of [
      { kind: 'multiple-choice', options: [{ label: 'A' }, { label: 'B' }] },
      { kind: 'permission' },
      { kind: 'answer-review' },
    ])
      should(agenda.ResolvedAgendaItemSchema.safeParse(withAsk(ask)).success).be.true();
    for (const ask of [{ kind: 'open-question' }, { kind: 'task' }, undefined])
      should(agenda.ResolvedAgendaItemSchema.safeParse(withAsk(ask)).success).be.false();
  });

  it('should keep an answer receipt on a resolved item only as a SHA-256 digest', () => {
    // Arrange
    const digest = 'a'.repeat(64);

    // Act / Assert
    should(agenda.ResolvedAgendaItemSchema.parse({ ...resolvedAgenda, answerReceipt: digest }).answerReceipt).equal(
      digest,
    );
    should(agenda.ResolvedAgendaItemSchema.safeParse(resolvedAgenda).success).be.true();
    for (const answerReceipt of ['still flickers', 'A'.repeat(64), 'a'.repeat(63)])
      should(agenda.ResolvedAgendaItemSchema.safeParse({ ...resolvedAgenda, answerReceipt }).success).be.false();
  });

  it('should reject ambiguous attention and resolution state', () => {
    // Arrange
    const multipleChoice = { kind: 'multiple-choice', options: [{ label: 'A' }, { label: 'B' }] };
    const cases: SchemaCase[] = [
      {
        name: 'duplicate choices',
        schema: agenda.AgendaAskSchema,
        value: { kind: 'multiple-choice', options: [{ label: 'A' }, { label: 'A' }] },
      },
      {
        name: 'multiline subject',
        schema: agenda.AgendaItemSchema,
        value: { ...agendaItem, subject: 'A\nB' },
      },
      {
        name: 'human with session',
        schema: agenda.AgendaItemSchema,
        value: { ...agendaItem, raisedBy: 'human', raisedBySession: 'spoof', raisedByName: null },
      },
      {
        name: 'sequence on task attention',
        schema: agenda.AgendaItemSchema,
        value: { ...agendaItem, source: 'task', sourceSeq: 1 },
      },
      {
        name: 'response without ask',
        schema: agenda.ResolvedAgendaItemSchema,
        value: { ...resolvedAgenda, ask: undefined },
      },
      {
        name: 'response kind mismatch',
        schema: agenda.ResolvedAgendaItemSchema,
        value: { ...resolvedAgenda, response: { kind: 'open-question', answer: 'x' } },
      },
      {
        name: 'choice outside options',
        schema: agenda.ResolvedAgendaItemSchema,
        value: {
          ...resolvedAgenda,
          ask: multipleChoice,
          response: { kind: 'multiple-choice', choice: 'C' },
        },
      },
      {
        name: 'dismissal with response',
        schema: agenda.ResolvedAgendaItemSchema,
        value: { ...resolvedAgenda, disposition: 'dismissed' },
      },
      {
        name: 'count mismatch',
        schema: agenda.AgendaSnapshotSchema,
        value: {
          v: 1,
          sessionId: 'session-1',
          items: [agendaItem],
          resolved: [],
          count: 0,
          parseErrors: 0,
          updatedAt: INSTANT,
        },
      },
      {
        name: 'duplicate active ids',
        schema: agenda.AgendaSnapshotSchema,
        value: {
          v: 1,
          sessionId: 'session-1',
          items: [agendaItem, agendaItem],
          resolved: [],
          count: 2,
          parseErrors: 0,
          updatedAt: INSTANT,
        },
      },
      {
        name: 'duplicate resolved ids',
        schema: agenda.AgendaSnapshotSchema,
        value: {
          v: 1,
          sessionId: 'session-1',
          items: [],
          resolved: [resolvedAgenda, resolvedAgenda],
          count: 0,
          parseErrors: 0,
          updatedAt: INSTANT,
        },
      },
      {
        name: 'active resolved overlap',
        schema: agenda.AgendaSnapshotSchema,
        value: {
          v: 1,
          sessionId: 'session-1',
          items: [agendaItem],
          resolved: [resolvedAgenda],
          count: 1,
          parseErrors: 0,
          updatedAt: INSTANT,
        },
      },
      {
        name: 'forbidden add source',
        schema: agenda.AgendaActionRequestSchema,
        value: { action: 'add', source: 'task', subject: 'x', why: 'x', howToResolve: 'x' },
      },
    ];

    // Act + Assert
    assertRejects(cases);
  });
});

describe('where a push opens, relative to the machine’s own pages', () => {
  it('names the conversation, and the item when there is one, escaping both', () => {
    // Arrange / Act
    const plain = agenda.sessionNotificationPath('session 1/x');
    const atItem = agenda.agendaNotificationPath('session 1/x', 'A3');

    // Assert
    should(plain).equal('/session/session%201%2Fx');
    should(atItem).equal('/session/session%201%2Fx?attention=A3');
  });
});

describe('pin schemas', () => {
  it('should round-trip every public pin schema', () => {
    // Arrange
    const cases = pinCases;

    // Act + Assert
    assertRoundTrips(cases);
    assertCoversEverySchema(pins, cases);
  });

  it('should resolve both pin kinds, both provenance kinds, and every action', () => {
    // Arrange
    const values = [messagePin, notePin];
    const actions = [
      { action: 'add', kind: 'note', text: 'Note' },
      { action: 'add', kind: 'message', blockId: 'block-1', blockKind: 'assistant', preview: 'Preview' },
      { action: 'edit', id: notePin.id, text: 'Edited' },
      { action: 'remove', id: messagePin.id },
    ];

    // Act + Assert
    for (const value of values) should(pins.PinSchema.safeParse(value).success).be.true();
    for (const value of actions) should(pins.PinActionRequestSchema.safeParse(value).success).be.true();
  });

  it('should reject invalid provenance, previews, duplicates, and historical actions', () => {
    // Arrange
    const duplicateBlock = { ...messagePin, id: '33333333-3333-4333-8333-333333333333' };
    const cases: SchemaCase[] = [
      {
        name: 'human pin with creator',
        schema: pins.MessagePinSchema,
        value: { ...messagePin, createdBy: 'session-1' },
      },
      {
        name: 'agent pin without creator',
        schema: pins.NotePinSchema,
        value: { ...notePin, createdBy: null },
      },
      { name: 'multiline preview', schema: pins.MessagePinSchema, value: { ...messagePin, preview: 'A\nB' } },
      {
        name: 'duplicate pin ids',
        schema: pins.PinSnapshotSchema,
        value: {
          v: 1,
          sessionId: 'session-1',
          pins: [messagePin, { ...notePin, id: messagePin.id }],
          updatedAt: INSTANT,
        },
      },
      {
        name: 'duplicate block ids',
        schema: pins.PinSnapshotSchema,
        value: { v: 1, sessionId: 'session-1', pins: [messagePin, duplicateBlock], updatedAt: INSTANT },
      },
      {
        name: 'nested add payload',
        schema: pins.PinActionRequestSchema,
        value: { action: 'add', pin: { kind: 'note', text: 'legacy' } },
      },
      { name: 'historical import', schema: pins.PinActionRequestSchema, value: { action: 'import', pins: [] } },
    ];

    // Act + Assert
    assertRejects(cases);
  });
});
