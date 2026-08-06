import { describe, it } from 'bun:test';
import should from 'should';
import * as attention from '../../src/lib/attention.ts';
import * as pins from '../../src/lib/pins.ts';
import * as boards from '../../src/lib/task-boards.ts';
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
    name: 'task list response',
    schema: tasks.TaskListResponseSchema,
    value: { tasks: [taskSummary], parseErrors: 0 },
  },
  {
    name: 'task detail response',
    schema: tasks.TaskDetailResponseSchema,
    value: { task: taskView, activity: [createdActivity] },
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
    name: 'fleet task list',
    schema: tasks.FleetTaskListResponseSchema,
    value: { v: 1, sessionId: null, tasks: [], parseErrors: 0, updatedAt: INSTANT },
  },
  {
    name: 'scoped detail',
    schema: tasks.ScopedTaskDetailResponseSchema,
    value: { sessionId: 'session-1', task: { ...taskView, sessionId: 'session-1' }, activity: [] },
  },
  {
    name: 'create request',
    schema: tasks.TaskCreateRequestSchema,
    value: {
      kind: 'feature',
      title: task.title,
      ask: task.ask,
      description: '',
      workflow: 'quick',
      dependsOn: [],
      files: [],
      status: 'todo',
      assignee: null,
      repo: null,
      links: {},
      order: null,
    },
  },
  { name: 'action request', schema: tasks.TaskActionRequestSchema, value: { action: 'note', text: 'progress' } },
  { name: 'task error', schema: tasks.TaskErrorCodeSchema, value: 'invalid' },
];

const readMembership = {
  sessionId: 'session-1',
  role: 'read',
  allowedActions: ['read'],
  boardEpoch: 1,
  coordinatorEpoch: 1,
  runtimeGeneration: 1,
};
const requestBase = {
  requestId: 'request-1',
  targetSessionId: 'session-2',
  requestedRole: 'worker',
  createdAt: INSTANT,
  expiresAt: LATER_INSTANT,
};
const invitationBase = {
  requestId: 'invite-1',
  sourceSessionId: 'session-1',
  targetSessionId: 'session-2',
  createdAt: INSTANT,
  expiresAt: LATER_INSTANT,
};

/** One board-aggregate row: a task summary that knows which member session owns it. */
const boardRow = {
  ...taskSummary,
  sessionId: 'session-1',
  sessionName: 'Ada',
  actions: ['read'],
};
const boardMember = { sessionId: 'session-1', name: 'Ada', role: 'worker', active: true };
const boardTaskList = {
  v: 1,
  boardId: 'board-1',
  boardEpoch: 1,
  coordinatorEpoch: 1,
  viewer: { kind: 'member', membership: readMembership },
  members: [boardMember],
  rows: [boardRow],
  updatedAt: INSTANT,
};

const boardCases: SchemaCase[] = [
  { name: 'board role', schema: boards.TaskBoardRoleSchema, value: 'worker' },
  { name: 'active board role', schema: boards.TaskBoardActiveRoleSchema, value: 'worker' },
  { name: 'board member', schema: boards.BoardMemberSchema, value: boardMember },
  { name: 'board task row', schema: boards.BoardTaskRowSchema, value: boardRow },
  { name: 'board viewer', schema: boards.BoardViewerSchema, value: { kind: 'human_admin' } },
  { name: 'board task list', schema: boards.BoardTaskListResponseSchema, value: boardTaskList },
  { name: 'child access', schema: boards.TaskBoardChildAccessSchema, value: 'worker' },
  { name: 'board action', schema: boards.TaskBoardActionSchema, value: 'read' },
  { name: 'membership', schema: boards.TaskBoardMembershipSchema, value: readMembership },
  { name: 'grant status', schema: boards.TaskBoardGrantRequestStatusSchema, value: 'pending' },
  { name: 'grant view', schema: boards.TaskBoardGrantRequestViewSchema, value: { ...requestBase, status: 'pending' } },
  { name: 'invitation status', schema: boards.TaskBoardInvitationStatusSchema, value: 'pending' },
  {
    name: 'invitation view',
    schema: boards.TaskBoardInvitationViewSchema,
    value: { ...invitationBase, status: 'pending' },
  },
  {
    name: 'create board',
    schema: boards.TaskBoardCreateRequestSchema,
    value: { creatorSessionId: 'session-1', coordinatorSessionId: 'session-2' },
  },
  {
    name: 'create board response',
    schema: boards.TaskBoardCreateResponseSchema,
    value: { created: true, creator: readMembership, coordinator: readMembership },
  },
  {
    name: 'child grant request',
    schema: boards.TaskBoardChildGrantRequestSchema,
    value: { targetSessionId: 'session-2', role: 'worker' },
  },
  {
    name: 'child grant approval',
    schema: boards.TaskBoardChildGrantApprovalSchema,
    value: { grantRequestId: 'request-1' },
  },
  {
    name: 'invitation request',
    schema: boards.TaskBoardInvitationRequestSchema,
    value: { targetSessionId: 'session-2' },
  },
  {
    name: 'invitation approval',
    schema: boards.TaskBoardInvitationApprovalSchema,
    value: { invitationRequestId: 'invite-1' },
  },
  {
    name: 'mark done',
    schema: boards.TaskBoardMarkDoneRequestSchema,
    value: { sessionId: 'session-1', enabled: true },
  },
  {
    name: 'replace coordinator',
    schema: boards.TaskBoardCoordinatorReplacementSchema,
    value: { sessionId: 'session-1', replacementSessionId: 'session-2' },
  },
  {
    name: 'revoke grant',
    schema: boards.TaskBoardGrantRevocationSchema,
    value: { sessionId: 'session-1', targetSessionId: 'session-2', reason: 'finished' },
  },
  { name: 'accept invitation', schema: boards.TaskBoardInvitationAcceptRequestSchema, value: {} },
  { name: 'relinquish membership', schema: boards.TaskBoardMembershipRelinquishRequestSchema, value: {} },
  {
    name: 'relinquish response',
    schema: boards.TaskBoardRelinquishResponseSchema,
    value: { relinquished: true, sessionId: 'session-1', sessionStopped: false },
  },
  {
    name: 'revoke response',
    schema: boards.TaskBoardRevokeResponseSchema,
    value: { revoked: true, targetSessionId: 'session-2' },
  },
  { name: 'board error', schema: boards.TaskBoardErrorCodeSchema, value: 'forbidden' },
];

const permissionAsk = { kind: 'permission' };
const attentionItem = {
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
const resolvedAttention = {
  ...attentionItem,
  resolvedAt: LATER_INSTANT,
  resolvedBy: 'human',
  resolvedBySession: null,
  resolvedByName: null,
  resolutionNote: null,
  response: { kind: 'permission', decision: 'approve' },
  disposition: 'done',
};

const attentionCases: SchemaCase[] = [
  { name: 'attention source', schema: attention.AttentionSourceSchema, value: 'agent-raised' },
  {
    name: 'ask option',
    schema: attention.AttentionAskOptionSchema,
    value: { label: 'Proceed', description: 'Run the operation' },
  },
  { name: 'attention ask', schema: attention.AttentionAskSchema, value: permissionAsk },
  {
    name: 'attention response',
    schema: attention.AttentionResponseSchema,
    value: { kind: 'permission', decision: 'approve' },
  },
  { name: 'disposition', schema: attention.AttentionDispositionSchema, value: 'done' },
  { name: 'attention id', schema: attention.AttentionIdSchema, value: 'A1' },
  { name: 'attention actor', schema: attention.AttentionBySchema, value: 'agent' },
  { name: 'attention item', schema: attention.AttentionItemSchema, value: attentionItem },
  { name: 'resolved attention', schema: attention.ResolvedAttentionItemSchema, value: resolvedAttention },
  {
    name: 'attention snapshot',
    schema: attention.AttentionSnapshotSchema,
    value: {
      v: 1,
      sessionId: 'session-1',
      items: [attentionItem],
      resolved: [],
      count: 1,
      parseErrors: 0,
      updatedAt: INSTANT,
    },
  },
  {
    name: 'attention action',
    schema: attention.AttentionActionRequestSchema,
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
    schema: attention.DirectNotificationRequestSchema,
    value: { body: 'Finished', title: 'Complete', kind: 'completed' },
  },
  {
    name: 'attention count',
    schema: attention.AttentionCountResponseSchema,
    value: { sessionId: 'session-1', count: 1 },
  },
  {
    name: 'notification response',
    schema: attention.DirectNotificationResponseSchema,
    value: { sessionId: 'session-1', delivered: 1 },
  },
  { name: 'attention error', schema: attention.AttentionErrorCodeSchema, value: 'invalid' },
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

  it('should resolve every task action member', () => {
    // Arrange
    const values = [
      { action: 'status', status: 'blocked', reason: 'needs input' },
      { action: 'phase', phase: 'build', reason: 'approved' },
      { action: 'reopen', reason: 'regression', ask: 'Fix it', source: 'message-2' },
      { action: 'note', text: 'note' },
      { action: 'feedback', text: 'feedback' },
      { action: 'clarify', text: 'clarification', source: 'message-2' },
      { action: 'dependency', taskId: 'F2', remove: true },
      { action: 'file', path: 'src/file.ts', remove: true, reason: 'scope changed' },
      { action: 'link', field: 'commit', value: 'abc123' },
      { action: 'assign', assignee: null },
      { action: 'order', order: 1 },
    ];

    // Act + Assert
    for (const value of values) should(tasks.TaskActionRequestSchema.parse(value)).deepEqual(value);
  });

  it('should apply create defaults and accept historical nonterminal reasons', () => {
    // Arrange
    const input = { kind: 'feature', title: 'Build protocol', ask: { text: 'Build it', source: 'message-1' } };

    // Act
    const created = tasks.TaskCreateRequestSchema.parse(input);
    const historical = tasks.TaskSchema.parse({
      ...task,
      phase: 'build',
      status: 'in_progress',
      statusReason: 'rewound',
    });

    // Assert
    should(created.workflow).equal('quick');
    should(created.dependsOn).deepEqual([]);
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
        name: 'create blocked without reason',
        schema: tasks.TaskCreateRequestSchema,
        value: { kind: 'bug', title: 'Blocked bug', ask: task.ask, status: 'blocked' },
      },
      {
        name: 'create status outside workflow',
        schema: tasks.TaskCreateRequestSchema,
        value: { kind: 'feature', title: 'Research it', ask: task.ask, workflow: 'quick', status: 'researched' },
      },
      {
        name: 'status action without reason',
        schema: tasks.TaskActionRequestSchema,
        value: { action: 'status', status: 'in_progress' },
      },
      {
        name: 'opaque activity data',
        schema: tasks.TaskActivitySchema,
        value: { ...activityBase, type: 'note', data: { arbitrary: true } },
      },
    ];

    // Act + Assert
    assertRejects(cases);
  });
});

describe('task-board schemas', () => {
  it('should round-trip every public task-board schema', () => {
    // Arrange
    const cases = boardCases;

    // Act + Assert
    assertRoundTrips(cases);
    assertCoversEverySchema(boards, cases);
  });

  it('should resolve every grant and invitation status', () => {
    // Arrange
    const grants: unknown[] = ['pending', 'approved', 'expired'].map(status => ({ ...requestBase, status }));
    grants.push({ ...requestBase, status: 'refused', refusalReason: 'not allowed' });
    const invitations: unknown[] = ['pending', 'approved', 'accepted', 'expired'].map(status => ({
      ...invitationBase,
      status,
    }));
    invitations.push({ ...invitationBase, status: 'refused', refusalReason: 'declined' });

    // Act + Assert
    for (const value of grants) should(boards.TaskBoardGrantRequestViewSchema.safeParse(value).success).be.true();
    for (const value of invitations) should(boards.TaskBoardInvitationViewSchema.safeParse(value).success).be.true();
  });

  it('should reject role-incoherent or ambiguous board state', () => {
    // Arrange
    const cases: SchemaCase[] = [
      {
        name: 'duplicate actions',
        schema: boards.TaskBoardMembershipSchema,
        value: { ...readMembership, allowedActions: ['read', 'read'] },
      },
      {
        name: 'role escalation',
        schema: boards.TaskBoardMembershipSchema,
        value: { ...readMembership, allowedActions: ['read', 'assign'] },
      },
      {
        name: 'refused without reason',
        schema: boards.TaskBoardGrantRequestViewSchema,
        value: { ...requestBase, status: 'refused' },
      },
      {
        name: 'pending with reason',
        schema: boards.TaskBoardInvitationViewSchema,
        value: { ...invitationBase, status: 'pending', refusalReason: 'impossible' },
      },
      {
        name: 'nonempty accept body',
        schema: boards.TaskBoardInvitationAcceptRequestSchema,
        value: { capability: 'spoof' },
      },
    ];

    // Act + Assert
    assertRejects(cases);
  });
});

describe('attention schemas', () => {
  it('should round-trip every public attention schema', () => {
    // Arrange
    const cases = attentionCases;

    // Act + Assert
    assertRoundTrips(cases);
    assertCoversEverySchema(attention, cases);
  });

  it('should resolve every ask, response, provenance, and action member', () => {
    // Arrange
    const asks = [
      { kind: 'permission' },
      { kind: 'multiple-choice', options: [{ label: 'A' }, { label: 'B' }] },
      { kind: 'answer-review' },
      { kind: 'open-question' },
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
    ];

    // Act + Assert
    for (const value of asks) should(attention.AttentionAskSchema.safeParse(value).success).be.true();
    for (const value of responses) should(attention.AttentionResponseSchema.safeParse(value).success).be.true();
    for (const raisedBy of ['human', 'daemon'] as const) {
      should(
        attention.AttentionItemSchema.safeParse({
          ...attentionItem,
          raisedBy,
          raisedBySession: null,
          raisedByName: null,
        }).success,
      ).be.true();
    }
    for (const resolvedBy of ['agent', 'daemon'] as const) {
      should(
        attention.ResolvedAttentionItemSchema.safeParse({
          ...resolvedAttention,
          resolvedBy,
          resolvedBySession: resolvedBy === 'agent' ? 'session-2' : null,
          resolvedByName: resolvedBy === 'agent' ? 'Grace' : null,
        }).success,
      ).be.true();
    }
    for (const value of actions) should(attention.AttentionActionRequestSchema.safeParse(value).success).be.true();
  });

  it('should reject ambiguous attention and resolution state', () => {
    // Arrange
    const multipleChoice = { kind: 'multiple-choice', options: [{ label: 'A' }, { label: 'B' }] };
    const cases: SchemaCase[] = [
      {
        name: 'duplicate choices',
        schema: attention.AttentionAskSchema,
        value: { kind: 'multiple-choice', options: [{ label: 'A' }, { label: 'A' }] },
      },
      {
        name: 'multiline subject',
        schema: attention.AttentionItemSchema,
        value: { ...attentionItem, subject: 'A\nB' },
      },
      {
        name: 'human with session',
        schema: attention.AttentionItemSchema,
        value: { ...attentionItem, raisedBy: 'human', raisedBySession: 'spoof', raisedByName: null },
      },
      {
        name: 'sequence on task attention',
        schema: attention.AttentionItemSchema,
        value: { ...attentionItem, source: 'task', sourceSeq: 1 },
      },
      {
        name: 'response without ask',
        schema: attention.ResolvedAttentionItemSchema,
        value: { ...resolvedAttention, ask: undefined },
      },
      {
        name: 'response kind mismatch',
        schema: attention.ResolvedAttentionItemSchema,
        value: { ...resolvedAttention, response: { kind: 'open-question', answer: 'x' } },
      },
      {
        name: 'choice outside options',
        schema: attention.ResolvedAttentionItemSchema,
        value: {
          ...resolvedAttention,
          ask: multipleChoice,
          response: { kind: 'multiple-choice', choice: 'C' },
        },
      },
      {
        name: 'dismissal with response',
        schema: attention.ResolvedAttentionItemSchema,
        value: { ...resolvedAttention, disposition: 'dismissed' },
      },
      {
        name: 'count mismatch',
        schema: attention.AttentionSnapshotSchema,
        value: {
          v: 1,
          sessionId: 'session-1',
          items: [attentionItem],
          resolved: [],
          count: 0,
          parseErrors: 0,
          updatedAt: INSTANT,
        },
      },
      {
        name: 'duplicate active ids',
        schema: attention.AttentionSnapshotSchema,
        value: {
          v: 1,
          sessionId: 'session-1',
          items: [attentionItem, attentionItem],
          resolved: [],
          count: 2,
          parseErrors: 0,
          updatedAt: INSTANT,
        },
      },
      {
        name: 'duplicate resolved ids',
        schema: attention.AttentionSnapshotSchema,
        value: {
          v: 1,
          sessionId: 'session-1',
          items: [],
          resolved: [resolvedAttention, resolvedAttention],
          count: 0,
          parseErrors: 0,
          updatedAt: INSTANT,
        },
      },
      {
        name: 'active resolved overlap',
        schema: attention.AttentionSnapshotSchema,
        value: {
          v: 1,
          sessionId: 'session-1',
          items: [attentionItem],
          resolved: [resolvedAttention],
          count: 1,
          parseErrors: 0,
          updatedAt: INSTANT,
        },
      },
      {
        name: 'forbidden add source',
        schema: attention.AttentionActionRequestSchema,
        value: { action: 'add', source: 'task', subject: 'x', why: 'x', howToResolve: 'x' },
      },
    ];

    // Act + Assert
    assertRejects(cases);
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
