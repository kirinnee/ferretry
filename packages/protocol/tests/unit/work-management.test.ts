import { describe, it } from 'bun:test';
import should from 'should';
import * as agenda from '../../src/lib/agenda.ts';
import * as pins from '../../src/lib/pins.ts';
import * as tasks from '../../src/lib/tasks.ts';
import { INSTANT, LATER_INSTANT } from '../fixtures.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

const links = { prs: [], branch: null, commits: [], docs: [] };
const live = {
  assigneeSessionId: null,
  assigneeName: null,
  assigneeStatus: null,
  assigneeHealth: null,
  assigneeDoneMarker: false,
  assigneeLastActivityAt: null,
  staleness: null,
};
const task = {
  v: 1,
  id: 'F1',
  kind: 'feature',
  title: 'Build typed protocol',
  description: 'Build the shared protocol.',
  ask: { text: 'Build it', source: 'message-1' },
  clarifications: [],
  workflow: 'quick',
  phase: 'todo',
  dependsOn: [],
  status: 'todo',
  statusReason: null,
  assignee: null,
  repo: null,
  files: [],
  links,
  order: null,
  createdAt: INSTANT,
  createdBy: null,
  updatedAt: INSTANT,
};
const taskView = {
  ...task,
  live,
  blocked: false,
  blockedReason: null,
  blockedSince: null,
  blockedBy: [],
};
const taskSummary = {
  ...taskView,
  description: undefined,
  ask: undefined,
  clarifications: undefined,
  descriptionChars: task.description.length,
  askChars: task.ask.text.length,
  askSource: task.ask.source,
  clarificationCount: 0,
};
const activityBase = { v: 1, seq: 1, time: INSTANT, actor: 'user', actorName: null };

const authorization = {
  role: 'worker',
  boardEpoch: 1,
  coordinatorEpoch: 1,
  runtimeGeneration: 1,
  action: 'note',
  requestId: 'request-1',
};

const createdActivity = {
  ...activityBase,
  type: 'created',
  data: {
    status: 'todo',
    phase: 'todo',
    workflow: 'quick',
    kind: 'feature',
    title: 'Build typed protocol',
    askSource: 'message-1',
    dependsOn: [],
    reason: 'Task created.',
  },
};

const taskCases: SchemaCase[] = [
  { name: 'task kind', schema: tasks.TaskKindSchema, value: 'feature' },
  { name: 'task id', schema: tasks.TaskIdSchema, value: 'F1' },
  { name: 'task title', schema: tasks.TaskTitleSchema, value: task.title },
  { name: 'task status', schema: tasks.TaskStatusSchema, value: 'todo' },
  { name: 'task phase', schema: tasks.TaskPhaseSchema, value: 'todo' },
  { name: 'board lane', schema: tasks.TaskBoardLaneSchema, value: 'todo' },
  { name: 'workflow', schema: tasks.TaskWorkflowSchema, value: 'quick' },
  { name: 'task message', schema: tasks.TaskMessageSchema, value: task.ask },
  {
    name: 'clarification',
    schema: tasks.TaskClarificationSchema,
    value: { ...task.ask, at: INSTANT, by: 'user', byName: null },
  },
  { name: 'links', schema: tasks.TaskLinksSchema, value: links },
  { name: 'link field', schema: tasks.TaskLinkFieldSchema, value: 'pr' },
  { name: 'task', schema: tasks.TaskSchema, value: task },
  {
    name: 'done request fingerprint',
    schema: tasks.TaskDoneRequestFingerprintSchema,
    value: { action: 'phase', phase: 'done', reason: 'checked the release' },
  },
  { name: 'authorization', schema: tasks.TaskAuthorizationProvenanceSchema, value: authorization },
  {
    name: 'legacy attestation',
    schema: tasks.LegacyAttestationSchema,
    value: { reason: 'predates-actor-authority-split', splitLandedAt: INSTANT },
  },
  { name: 'activity type', schema: tasks.TaskActivityTypeSchema, value: 'created' },
  { name: 'activity', schema: tasks.TaskActivitySchema, value: createdActivity },
  { name: 'assignee health', schema: tasks.TaskAssigneeHealthSchema, value: 'active' },
  { name: 'staleness', schema: tasks.TaskStalenessSchema, value: 'quiet' },
  { name: 'live task state', schema: tasks.TaskLiveSchema, value: live },
  { name: 'task view', schema: tasks.TaskViewSchema, value: taskView },
  { name: 'scoped task view', schema: tasks.ScopedTaskViewSchema, value: { ...taskView, sessionId: 'session-1' } },
  { name: 'task summary', schema: tasks.TaskSummarySchema, value: taskSummary },
  {
    name: 'scoped task summary',
    schema: tasks.ScopedTaskSummarySchema,
    value: { ...taskSummary, sessionId: 'session-1' },
  },
  {
    name: 'session task list',
    schema: tasks.SessionTaskListResponseSchema,
    value: {
      v: 1,
      sessionId: 'session-1',
      tasks: [{ ...taskSummary, sessionId: 'session-1' }],
      parseErrors: 0,
      updatedAt: INSTANT,
    },
  },
  {
    name: 'scoped detail',
    schema: tasks.ScopedTaskDetailResponseSchema,
    value: { sessionId: 'session-1', task: { ...taskView, sessionId: 'session-1' }, activity: [] },
  },
];

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

const agendaCases: SchemaCase[] = [
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
  {
    name: 'brief term',
    schema: agenda.AgendaTermSchema,
    value: { term: 'OCI', meaning: 'Oracle Cloud Infrastructure' },
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
  { name: 'attention id', schema: agenda.AgendaIdSchema, value: 'A1' },
  { name: 'attention actor', schema: agenda.AgendaBySchema, value: 'agent' },
  { name: 'attention item', schema: agenda.AgendaItemSchema, value: agendaItem },
  { name: 'resolved attention', schema: agenda.ResolvedAgendaItemSchema, value: resolvedAgenda },
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

describe('task schemas', () => {
  it('should round-trip every public task schema', () => {
    // Arrange
    const cases = taskCases;

    // Act + Assert
    assertRoundTrips(cases);
    assertCoversEverySchema(tasks, cases);
  });

  it('should resolve every task activity member and both session events', () => {
    // Arrange
    const values = [
      createdActivity,
      {
        ...activityBase,
        type: 'status',
        data: { from: 'todo', to: 'in_progress', phaseFrom: 'todo', phaseTo: 'build', reason: 'started' },
      },
      {
        ...activityBase,
        actor: 'peer:session-1',
        type: 'status',
        data: {
          from: 'live',
          to: 'done',
          phaseFrom: 'live',
          phaseTo: 'done',
          reason: 'checked the release',
          verifiedByTopAgent: true,
          attestationSemantics: tasks.ACTOR_AUTHORITY_SPLIT_SEMANTICS,
          authorization: {
            boardId: 'board-1',
            grantId: 'grant-1',
            sessionId: 'session-1',
            targetSessionId: 'session-1',
            role: 'top_agent',
            boardEpoch: 1,
            coordinatorEpoch: 1,
            runtimeGeneration: 1,
            action: 'mark_done',
            requestId: 'completion-1',
            requestFingerprint: { action: 'phase', phase: 'done', reason: 'checked the release' },
          },
        },
      },
      {
        ...activityBase,
        type: 'status',
        data: {
          from: 'live',
          to: 'done',
          phaseFrom: 'live',
          phaseTo: 'done',
          reason: 'historical record',
          verifiedByHuman: true,
          legacyAttestation: { reason: 'predates-actor-authority-split', splitLandedAt: INSTANT },
        },
      },
      { ...activityBase, type: 'note', data: { text: 'note' } },
      { ...activityBase, type: 'link', data: { field: 'pr', value: 'https://example.test/pr/1' } },
      { ...activityBase, type: 'assign', data: { from: null, to: 'session-1' } },
      { ...activityBase, type: 'order', data: { from: null, to: 1 } },
      { ...activityBase, type: 'feedback', data: { text: 'feedback', authorization } },
      { ...activityBase, type: 'clarification', data: { text: 'clarified', source: 'message-2' } },
      { ...activityBase, type: 'dependency', data: { taskId: 'F2', operation: 'add' } },
      { ...activityBase, type: 'file', data: { path: 'src/file.ts', operation: 'add' } },
      {
        ...activityBase,
        type: 'session',
        data: { event: 'completion-claim', session: 'session-1', turn: 0, phase: 'build', claimedAt: INSTANT },
      },
      {
        ...activityBase,
        type: 'session',
        data: { event: 'reopen-ack', reopenAck: 1, resolvedBy: 'user', resolvedByName: null },
      },
    ];

    // Act + Assert
    for (const value of values) should(tasks.TaskActivitySchema.parse(value)).deepEqual(value);
  });

  it('should retain unstamped human attestations that the previous release wrote', () => {
    // These records are intentionally not held to the new writer's semantic invariants. A reader
    // must retain them so it can mark their human claims legacy-unreliable instead of treating the
    // entire snapshot as damaged.
    const values = [
      {
        ...activityBase,
        type: 'status',
        data: {
          from: 'blocked',
          to: 'researched',
          phaseFrom: 'research',
          phaseTo: 'research',
          reason: 'unblocked',
          approvedByHuman: true,
        },
      },
      {
        ...activityBase,
        type: 'status',
        data: {
          from: 'blocked',
          to: 'done',
          phaseFrom: 'live',
          phaseTo: 'done',
          reason: 'validated after unblock',
          verifiedByHuman: true,
        },
      },
    ];

    for (const value of values) should(tasks.TaskActivitySchema.parse(value)).deepEqual(value);
  });

  it('should preserve blocked completion overlays and reject blocked destinations that advance phase', () => {
    const reason = 'completed while manually blocked';
    const attestations = [
      { name: 'human', actor: 'user', evidence: { verifiedByHuman: true } },
      {
        name: 'top-agent',
        actor: 'peer:session-1',
        evidence: {
          verifiedByTopAgent: true,
          authorization: {
            boardId: 'board-1',
            grantId: 'grant-1',
            sessionId: 'session-1',
            targetSessionId: 'session-1',
            role: 'top_agent',
            boardEpoch: 1,
            coordinatorEpoch: 1,
            runtimeGeneration: 1,
            action: 'mark_done',
            requestId: 'completion-1',
            requestFingerprint: { action: 'phase', phase: 'done', reason },
          },
        },
      },
    ] as const;
    const contradictoryCases: SchemaCase[] = [];

    for (const { name, actor, evidence } of attestations) {
      const completion = {
        ...activityBase,
        actor,
        type: 'status',
        data: {
          from: 'blocked',
          to: 'done',
          phaseFrom: 'live',
          phaseTo: 'done',
          reason,
          ...evidence,
          attestationSemantics: tasks.ACTOR_AUTHORITY_SPLIT_SEMANTICS,
        },
      };
      should(tasks.TaskActivitySchema.parse(completion)).deepEqual(completion);
      contradictoryCases.push({
        name: `${name} blocked destination advancing phase`,
        schema: tasks.TaskActivitySchema,
        value: { ...completion, data: { ...completion.data, to: 'blocked' } },
      });
    }

    assertRejects(contradictoryCases);
  });

  it('should accept historical nonterminal reasons', () => {
    // Act
    const historical = tasks.TaskSchema.parse({
      ...task,
      phase: 'build',
      status: 'in_progress',
      statusReason: 'rewound',
    });

    // Assert
    should(historical.statusReason).equal('rewound');
  });

  it('should reject incoherent task records and actions', () => {
    // Arrange
    const cases: SchemaCase[] = [
      { name: 'too many title words', schema: tasks.TaskTitleSchema, value: 'one two three four five six' },
      { name: 'oversized id', schema: tasks.TaskIdSchema, value: 'F1234567890' },
      { name: 'kind prefix mismatch', schema: tasks.TaskSchema, value: { ...task, id: 'B1' } },
      { name: 'blocked without reason', schema: tasks.TaskSchema, value: { ...task, status: 'blocked' } },
      {
        name: 'phase outside workflow',
        schema: tasks.TaskSchema,
        value: { ...task, workflow: 'quick', phase: 'research', status: 'researched' },
      },
      { name: 'status phase mismatch', schema: tasks.TaskSchema, value: { ...task, phase: 'build', status: 'todo' } },
      {
        name: 'opaque activity data',
        schema: tasks.TaskActivitySchema,
        value: { ...activityBase, type: 'note', data: { arbitrary: true } },
      },
      {
        name: 'human verification outside a live completion',
        schema: tasks.TaskActivitySchema,
        value: {
          ...activityBase,
          type: 'status',
          data: {
            from: 'in_progress',
            to: 'built',
            phaseFrom: 'build',
            phaseTo: 'built',
            reason: 'not a completion',
            verifiedByHuman: true,
            attestationSemantics: tasks.ACTOR_AUTHORITY_SPLIT_SEMANTICS,
          },
        },
      },
      {
        name: 'human verification whose status contradicts its completion phase',
        schema: tasks.TaskActivitySchema,
        value: {
          ...activityBase,
          type: 'status',
          data: {
            from: 'todo',
            to: 'in_progress',
            phaseFrom: 'live',
            phaseTo: 'done',
            reason: 'contradictory transition',
            verifiedByHuman: true,
            attestationSemantics: tasks.ACTOR_AUTHORITY_SPLIT_SEMANTICS,
          },
        },
      },
      {
        name: 'current human verification attributed to a peer actor',
        schema: tasks.TaskActivitySchema,
        value: {
          ...activityBase,
          actor: 'peer:session-1',
          type: 'status',
          data: {
            from: 'live',
            to: 'done',
            phaseFrom: 'live',
            phaseTo: 'done',
            reason: 'not a human actor',
            verifiedByHuman: true,
            attestationSemantics: tasks.ACTOR_AUTHORITY_SPLIT_SEMANTICS,
          },
        },
      },
      {
        name: 'top-agent verification outside a live completion',
        schema: tasks.TaskActivitySchema,
        value: {
          ...activityBase,
          actor: 'peer:session-1',
          type: 'status',
          data: {
            from: 'live',
            to: 'built',
            phaseFrom: 'live',
            phaseTo: 'built',
            reason: 'not a completion',
            verifiedByTopAgent: true,
            attestationSemantics: tasks.ACTOR_AUTHORITY_SPLIT_SEMANTICS,
            authorization: {
              boardId: 'board-1',
              grantId: 'grant-1',
              sessionId: 'session-1',
              targetSessionId: 'session-1',
              role: 'top_agent',
              boardEpoch: 1,
              coordinatorEpoch: 1,
              runtimeGeneration: 1,
              action: 'mark_done',
              requestId: 'completion-1',
              requestFingerprint: { action: 'phase', phase: 'done', reason: 'not a completion' },
            },
          },
        },
      },
      {
        name: 'human attestation carrying a board receipt',
        schema: tasks.TaskActivitySchema,
        value: {
          ...activityBase,
          type: 'status',
          data: {
            from: 'live',
            to: 'done',
            phaseFrom: 'live',
            phaseTo: 'done',
            reason: 'receipt cannot make this human',
            verifiedByHuman: true,
            attestationSemantics: tasks.ACTOR_AUTHORITY_SPLIT_SEMANTICS,
            authorization,
          },
        },
      },
      {
        name: 'semantics stamp without an attestation',
        schema: tasks.TaskActivitySchema,
        value: {
          ...activityBase,
          type: 'status',
          data: {
            from: 'todo',
            to: 'in_progress',
            phaseFrom: 'todo',
            phaseTo: 'build',
            reason: 'started',
            attestationSemantics: tasks.ACTOR_AUTHORITY_SPLIT_SEMANTICS,
          },
        },
      },
      {
        name: 'contradictory human and top-agent attestations',
        schema: tasks.TaskActivitySchema,
        value: {
          ...activityBase,
          type: 'status',
          data: {
            from: 'live',
            to: 'done',
            phaseFrom: 'live',
            phaseTo: 'done',
            reason: 'contradictory',
            verifiedByHuman: true,
            verifiedByTopAgent: true,
            attestationSemantics: tasks.ACTOR_AUTHORITY_SPLIT_SEMANTICS,
          },
        },
      },
      {
        name: 'top-agent attestation without exact authorization receipt',
        schema: tasks.TaskActivitySchema,
        value: {
          ...activityBase,
          type: 'status',
          data: {
            from: 'live',
            to: 'done',
            phaseFrom: 'live',
            phaseTo: 'done',
            reason: 'incomplete evidence',
            verifiedByTopAgent: true,
            attestationSemantics: tasks.ACTOR_AUTHORITY_SPLIT_SEMANTICS,
            authorization,
          },
        },
      },
      {
        name: 'top-agent attestation with blank durable authorization ids',
        schema: tasks.TaskActivitySchema,
        value: {
          ...activityBase,
          actor: 'peer:session-1',
          type: 'status',
          data: {
            from: 'live',
            to: 'done',
            phaseFrom: 'live',
            phaseTo: 'done',
            reason: 'blank evidence is not evidence',
            verifiedByTopAgent: true,
            attestationSemantics: tasks.ACTOR_AUTHORITY_SPLIT_SEMANTICS,
            authorization: {
              boardId: 'board-1',
              grantId: '   ',
              sessionId: 'session-1',
              targetSessionId: 'session-1',
              role: 'top_agent',
              boardEpoch: 1,
              coordinatorEpoch: 1,
              runtimeGeneration: 1,
              action: 'mark_done',
              requestId: '   ',
              requestFingerprint: {
                action: 'phase',
                phase: 'done',
                reason: 'blank evidence is not evidence',
              },
            },
          },
        },
      },
      {
        name: 'top-agent receipt for a different completion request',
        schema: tasks.TaskActivitySchema,
        value: {
          ...activityBase,
          actor: 'peer:session-1',
          type: 'status',
          data: {
            from: 'live',
            to: 'done',
            phaseFrom: 'live',
            phaseTo: 'done',
            reason: 'recorded completion',
            verifiedByTopAgent: true,
            attestationSemantics: tasks.ACTOR_AUTHORITY_SPLIT_SEMANTICS,
            authorization: {
              boardId: 'board-1',
              grantId: 'grant-1',
              sessionId: 'session-1',
              targetSessionId: 'session-1',
              role: 'top_agent',
              boardEpoch: 1,
              coordinatorEpoch: 1,
              runtimeGeneration: 1,
              action: 'mark_done',
              requestId: 'completion-1',
              requestFingerprint: { action: 'phase', phase: 'done', reason: 'different completion' },
            },
          },
        },
      },
      {
        name: 'unstamped top-agent attestation',
        schema: tasks.TaskActivitySchema,
        value: {
          ...activityBase,
          type: 'status',
          data: {
            from: 'live',
            to: 'done',
            phaseFrom: 'live',
            phaseTo: 'done',
            reason: 'missing semantics',
            verifiedByTopAgent: true,
            authorization: {
              boardId: 'board-1',
              role: 'top_agent',
              boardEpoch: 1,
              coordinatorEpoch: 1,
              runtimeGeneration: 1,
              action: 'mark_done',
              requestId: 'completion-1',
              requestFingerprint: { action: 'phase', phase: 'done', reason: 'missing semantics' },
            },
          },
        },
      },
      {
        name: 'legacy marker without an unstamped human attestation',
        schema: tasks.TaskActivitySchema,
        value: {
          ...activityBase,
          type: 'status',
          data: {
            from: 'live',
            to: 'done',
            phaseFrom: 'live',
            phaseTo: 'done',
            reason: 'a marker cannot invent its attestation',
            legacyAttestation: { reason: 'predates-actor-authority-split', splitLandedAt: INSTANT },
          },
        },
      },
      {
        name: 'stamped legacy marker',
        schema: tasks.TaskActivitySchema,
        value: {
          ...activityBase,
          type: 'status',
          data: {
            from: 'live',
            to: 'done',
            phaseFrom: 'live',
            phaseTo: 'done',
            reason: 'contradictory legacy',
            verifiedByHuman: true,
            attestationSemantics: tasks.ACTOR_AUTHORITY_SPLIT_SEMANTICS,
            legacyAttestation: { reason: 'predates-actor-authority-split', splitLandedAt: INSTANT },
          },
        },
      },
      {
        name: 'same-phase human approval',
        schema: tasks.TaskActivitySchema,
        value: {
          ...activityBase,
          type: 'status',
          data: {
            from: 'blocked',
            to: 'researched',
            phaseFrom: 'research',
            phaseTo: 'research',
            reason: 'unblocked',
            approvedByHuman: true,
            attestationSemantics: tasks.ACTOR_AUTHORITY_SPLIT_SEMANTICS,
          },
        },
      },
      {
        name: 'backward human approval',
        schema: tasks.TaskActivitySchema,
        value: {
          ...activityBase,
          type: 'status',
          data: {
            from: 'designed',
            to: 'researched',
            phaseFrom: 'design',
            phaseTo: 'research',
            reason: 'not an approval',
            approvedByHuman: true,
            attestationSemantics: tasks.ACTOR_AUTHORITY_SPLIT_SEMANTICS,
          },
        },
      },
    ];

    // Act + Assert
    assertRejects(cases);
  });
});

describe('attention schemas', () => {
  it('should round-trip every public attention schema', () => {
    // Arrange
    const cases = agendaCases;

    // Act + Assert
    assertRoundTrips(cases);
    assertCoversEverySchema(agenda, cases);
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
