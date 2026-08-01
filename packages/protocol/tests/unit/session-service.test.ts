import { describe, it } from 'bun:test';
import should from 'should';
import * as service from '../../src/lib/service.ts';
import * as session from '../../src/lib/session.ts';
import {
  attachmentView,
  cgroupConfigView,
  fleetIdleFrame,
  fyEvent,
  fyEventFrame,
  healthView,
  INSTANT,
  LATER_INSTANT,
  pwaConfigView,
  scratchPlanView,
  scratchSweepView,
  sessionAttachTarget,
  sessionIdleFrame,
  sessionView,
  usageFeedView,
  wardenConfig,
  wardenConfigView,
  wardenRunView,
  wardenStatusView,
} from '../fixtures.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

const sendEvidence = {
  key: 'send-1',
  harness: 'codex',
  kind: 'chat.user',
  proof: 'normal-user-record',
  observedAt: INSTANT,
  shapeVersion: 1,
  matchedTurn: 1,
  tier: 'exact-text',
};

const sendRecord = {
  v: 1,
  sendId: 'send-1',
  acceptedAt: INSTANT,
  acceptedTurn: 1,
  path: 'direct',
  message: 'Continue',
  attachmentIds: [],
  fate: 'delivered',
  evidence: sendEvidence,
};

const transcriptProvenance = {
  v: 1,
  home: '/home/agent/.claude',
  harnessSessionId: '11111111-2222-3333-4444-555555555555',
  identity: 'minted',
  correlationToken: '/state/sessions/session-1',
  file: '/home/agent/.claude/projects/-work-repo/11111111-2222-3333-4444-555555555555.jsonl',
  resolvedAt: INSTANT,
};

const pendingQuestion = {
  toolUseId: 'tool-1',
  questions: [{ question: 'Proceed?', header: 'Choice', options: [{ label: 'Yes' }], multiSelect: false }],
};

const sessionCases: SchemaCase[] = [
  { name: 'harness', schema: session.HarnessSchema, value: 'codex' },
  { name: 'interaction mode', schema: session.InteractionModeSchema, value: 'auto' },
  { name: 'send fate', schema: session.SendFateSchema, value: 'delivered' },
  { name: 'send path', schema: session.SendPathSchema, value: 'direct' },
  { name: 'send reason', schema: session.SendUnaccountedReasonSchema, value: 'timeout' },
  { name: 'send evidence', schema: session.SendEvidenceSchema, value: sendEvidence },
  { name: 'send record', schema: session.SendRecordSchema, value: sendRecord },
  { name: 'send list', schema: session.SendListResponseSchema, value: { sends: [sendRecord] } },
  { name: 'runtime option', schema: session.RuntimeModelOptionSchema, value: { value: 'model', label: 'Model' } },
  {
    name: 'reasoning choice',
    schema: session.RuntimeReasoningChoiceSchema,
    value: { value: 'high', description: 'High reasoning' },
  },
  {
    name: 'model choice',
    schema: session.RuntimeModelChoiceSchema,
    value: {
      value: 'model',
      label: 'Model',
      description: 'Recommended',
      isDefault: true,
      reasoningEfforts: [{ value: 'high' }],
      defaultReasoningEffort: 'high',
    },
  },
  {
    name: 'model catalog',
    schema: session.RuntimeModelCatalogSchema,
    value: {
      harness: 'codex',
      source: 'codex-app-server',
      choices: [{ value: 'model', label: 'Model', reasoningEfforts: [] }],
    },
  },
  { name: 'runtime control', schema: session.RuntimeControlRequestSchema, value: { action: 'model', model: 'model' } },
  { name: 'session status', schema: session.SessionStatusSchema, value: 'running' },
  { name: 'question option', schema: session.PendingQuestionOptionSchema, value: { label: 'Yes' } },
  { name: 'pending question', schema: session.PendingQuestionSchema, value: pendingQuestion },
  { name: 'board access', schema: session.TaskBoardAccessSchema, value: 'worker' },
  { name: 'transcript identity', schema: session.TranscriptIdentitySchema, value: 'minted' },
  { name: 'transcript provenance', schema: session.TranscriptProvenanceSchema, value: transcriptProvenance },
  {
    name: 'undiscovered transcript provenance',
    schema: session.TranscriptProvenanceSchema,
    value: { v: 1, home: '/home/agent/.codex', identity: 'undiscovered', baseline: ['rollout-1'] },
  },
  {
    name: 'session config with transcript provenance',
    schema: session.SessionConfigSchema,
    value: { ...sessionView.config, transcript: transcriptProvenance },
  },
  { name: 'session config', schema: session.SessionConfigSchema, value: sessionView.config },
  { name: 'session health', schema: session.SessionHealthSchema, value: 'healthy' },
  { name: 'account availability', schema: session.AccountAvailabilitySchema, value: 'available' },
  { name: 'account reason', schema: session.AccountUnavailableReasonSchema, value: 'cooldown' },
  {
    name: 'account usage',
    schema: session.AccountUsageSchema,
    value: { agent: 'agent', availability: 'available', retryAt: null, fiveHourPercent: 25 },
  },
  { name: 'session state', schema: session.SessionStateSchema, value: sessionView.state },
  { name: 'session view', schema: session.SessionViewSchema, value: sessionView },
  { name: 'session list', schema: session.SessionListSchema, value: [sessionView] },
  { name: 'attach target', schema: session.SessionAttachTargetSchema, value: sessionAttachTarget },
  { name: 'name suggestions', schema: session.NameSuggestionsSchema, value: ['Ada'] },
  { name: 'event source', schema: session.FyEventSourceSchema, value: 'daemon' },
  { name: 'event', schema: session.FyEventSchema, value: fyEvent },
  { name: 'event list', schema: session.FyEventListSchema, value: [fyEvent] },
  { name: 'session idle scope', schema: session.FyEventStreamIdleScopeSchema, value: sessionIdleFrame.scope },
  { name: 'fleet idle scope', schema: session.FyEventStreamIdleScopeSchema, value: fleetIdleFrame.scope },
  { name: 'event frame', schema: session.FyEventStreamFrameSchema, value: fyEventFrame },
  { name: 'session idle frame', schema: session.FyEventStreamFrameSchema, value: sessionIdleFrame },
  { name: 'fleet idle frame', schema: session.FyEventStreamFrameSchema, value: fleetIdleFrame },
  {
    name: 'start request',
    schema: session.StartSessionRequestSchema,
    value: { agent: 'agent', mode: 'auto', prompt: 'Do work', boardAccess: 'none' },
  },
  { name: 'send request', schema: session.SendRequestSchema, value: { message: 'Continue' } },
  {
    name: 'answer request',
    schema: session.AnswerSessionRequestSchema,
    value: { toolUseId: 'tool-1', labels: ['Yes'] },
  },
  { name: 'interrupt request', schema: session.InterruptSessionRequestSchema, value: { toolUseId: 'tool-1' } },
  { name: 'stop request', schema: session.StopSessionRequestSchema, value: { reason: 'done' } },
  { name: 'resume request', schema: session.ResumeSessionRequestSchema, value: { message: 'continue' } },
  {
    name: 'migrate request',
    schema: session.MigrateSessionRequestSchema,
    value: { agent: 'next', allowContextDowngrade: false },
  },
  { name: 'rename request', schema: session.RenameSessionRequestSchema, value: { name: 'New Name' } },
  { name: 'send disposition', schema: session.SendDispositionSchema, value: 'delivered' },
  { name: 'send result', schema: session.SendResultSchema, value: { ...sessionView, disposition: 'delivered' } },
  { name: 'signal kind', schema: session.SignalKindSchema, value: 'done' },
  { name: 'signal options', schema: session.SignalOptionsSchema, value: { until: INSTANT } },
  { name: 'signal request', schema: session.SignalSessionRequestSchema, value: { kind: 'done' } },
];

const anomaly = {
  kind: 'sus_thinking',
  sessionId: 'session-1',
  status: 'thinking',
  detail: 'tokens stopped',
};

const serviceCases: SchemaCase[] = [
  { name: 'health', schema: service.HealthViewSchema, value: healthView },
  { name: 'cgroup limit', schema: service.CgroupLimitSchema, value: { cpuPercent: 50, memoryPercent: 50 } },
  { name: 'cgroup config', schema: service.CgroupConfigSchema, value: cgroupConfigView.config },
  { name: 'cgroup patch', schema: service.CgroupConfigPatchSchema, value: { enabled: false } },
  { name: 'cgroup view', schema: service.CgroupConfigViewSchema, value: cgroupConfigView },
  { name: 'PWA config', schema: service.PwaConfigSchema, value: pwaConfigView.config },
  { name: 'PWA patch', schema: service.PwaConfigPatchSchema, value: { name: 'New Name', icon: 'F' } },
  { name: 'PWA view', schema: service.PwaConfigViewSchema, value: pwaConfigView },
  { name: 'warden policy', schema: service.WardenFailoverPolicySchema, value: 'fallback' },
  { name: 'warden account', schema: service.WardenAccountSchema, value: wardenConfig.accounts[0] },
  { name: 'warden failover', schema: service.WardenFailoverConfigSchema, value: wardenConfig.failover },
  { name: 'provider outage', schema: service.ProviderOutageConfigSchema, value: wardenConfig.providerOutage },
  { name: 'warden config', schema: service.WardenConfigSchema, value: wardenConfig },
  { name: 'warden patch', schema: service.WardenConfigPatchSchema, value: { enabled: false } },
  { name: 'warden anomaly kind', schema: service.WardenAnomalyKindSchema, value: 'sus_thinking' },
  { name: 'liveness ledger', schema: service.LivenessLedgerSchema, value: { lastTranscriptAt: INSTANT } },
  { name: 'warden anomaly', schema: service.WardenAnomalySchema, value: anomaly },
  {
    name: 'failover account view',
    schema: service.WardenFailoverAccountViewSchema,
    value: { agent: 'agent', eligible: true },
  },
  {
    name: 'failover status',
    schema: service.WardenFailoverStatusSchema,
    value: { policy: 'fallback', failureThreshold: 2, cooldownMinutes: 5, accounts: [] },
  },
  { name: 'warden config view', schema: service.WardenConfigViewSchema, value: wardenConfigView },
  { name: 'warden status', schema: service.WardenStatusViewSchema, value: wardenStatusView },
  { name: 'warden run', schema: service.WardenRunViewSchema, value: wardenRunView },
  { name: 'warden run request', schema: service.WardenRunRequestSchema, value: { spawn: true } },
  { name: 'usage account', schema: service.UsageAccountViewSchema, value: usageFeedView.accounts[0] },
  { name: 'usage feed', schema: service.UsageFeedViewSchema, value: usageFeedView },
  { name: 'attachment', schema: service.AttachmentViewSchema, value: attachmentView },
  { name: 'scratch entry', schema: service.ScratchEntrySchema, value: scratchPlanView.entries[0] },
  { name: 'scratch plan', schema: service.ScratchPlanViewSchema, value: scratchPlanView },
  { name: 'scratch plans', schema: service.ScratchPlanListSchema, value: [scratchPlanView] },
  { name: 'scratch sweep', schema: service.ScratchSweepViewSchema, value: scratchSweepView },
  { name: 'scratch request', schema: service.ScratchSweepRequestSchema, value: { force: true } },
  { name: 'empty response', schema: service.EmptyResponseSchema, value: undefined },
];

describe('session schemas', () => {
  it('should round-trip every public session schema', () => {
    // Arrange
    const cases = sessionCases;

    // Act + Assert
    assertRoundTrips(cases);
    assertCoversEverySchema(session, cases);
  });

  it('should resolve every runtime-control and signal union member', () => {
    // Arrange
    const controls = [{ action: 'model', model: 'm' }, { action: 'effort', effort: 'high' }, { action: 'compact' }];
    const signals = [
      { kind: 'done', message: 'complete' },
      { kind: 'help', message: 'blocked' },
      { kind: 'waiting', until: INSTANT, condition: 'CI', peer: 'peer-1' },
      { kind: 'working', message: 'resumed' },
    ];

    // Act + Assert
    for (const value of controls) should(session.RuntimeControlRequestSchema.parse(value)).deepEqual(value);
    for (const value of signals) should(session.SignalSessionRequestSchema.parse(value)).deepEqual(value);
  });

  it('should resolve both start modes and apply request defaults', () => {
    // Arrange
    const auto = { agent: 'agent', mode: 'auto', prompt: 'work' };
    const interactive = { agent: 'agent', mode: 'interactive' };

    // Act
    const parsedAuto = session.StartSessionRequestSchema.parse(auto);
    const parsedInteractive = session.StartSessionRequestSchema.parse(interactive);

    // Assert
    should(parsedAuto.mode).equal('auto');
    should(parsedAuto.boardAccess).equal('none');
    should(parsedInteractive.mode).equal('interactive');
  });

  it('should reject impossible or untrusted session requests', () => {
    // Arrange
    const cases: SchemaCase[] = [
      {
        name: 'auto without prompt',
        schema: session.StartSessionRequestSchema,
        value: { agent: 'agent', mode: 'auto' },
      },
      {
        name: 'board access without parent',
        schema: session.StartSessionRequestSchema,
        value: { agent: 'agent', mode: 'auto', prompt: 'work', boardAccess: 'worker' },
      },
      {
        name: 'interactive board access',
        schema: session.StartSessionRequestSchema,
        value: { agent: 'agent', mode: 'interactive', parent: 'parent', boardAccess: 'worker' },
      },
      {
        name: 'malformed attachment bytes',
        schema: session.StartSessionRequestSchema,
        value: {
          agent: 'agent',
          mode: 'auto',
          prompt: 'work',
          initialAttachments: [{ filename: 'x', base64: '***' }],
        },
      },
      { name: 'empty rename', schema: session.RenameSessionRequestSchema, value: {} },
      { name: 'help without message', schema: session.SignalSessionRequestSchema, value: { kind: 'help' } },
      {
        name: 'working with wait fields',
        schema: session.SignalSessionRequestSchema,
        value: { kind: 'working', until: INSTANT },
      },
      { name: 'unknown send key', schema: session.SendRequestSchema, value: { message: 'x', from: 'spoof' } },
      {
        // An identity with no harness session is the shape that would let a reader believe a
        // transcript had been attributed when nothing was.
        name: 'identified transcript naming no harness session',
        schema: session.TranscriptProvenanceSchema,
        value: { v: 1, home: '/home/agent/.claude', identity: 'minted', file: '/transcript.jsonl' },
      },
      {
        name: 'identified transcript naming no file',
        schema: session.TranscriptProvenanceSchema,
        value: { v: 1, home: '/home/agent/.claude', identity: 'correlated', harnessSessionId: 'rollout-1' },
      },
      {
        name: 'undiscovered transcript naming a file anyway',
        schema: session.TranscriptProvenanceSchema,
        value: { v: 1, home: '/home/agent/.codex', identity: 'undiscovered', file: '/transcript.jsonl' },
      },
    ];

    // Act + Assert
    assertRejects(cases);
  });

  it('should reject attach evidence that cannot address exactly one live pane', () => {
    // Arrange — every field here is what stops an attach landing on somebody else's terminal.
    const cases: SchemaCase[] = [
      {
        name: 'a relative tmux socket',
        schema: session.SessionAttachTargetSchema,
        value: { ...sessionAttachTarget, socketPath: 'tmux.sock' },
      },
      {
        name: 'a session name instead of a pane id',
        schema: session.SessionAttachTargetSchema,
        value: { ...sessionAttachTarget, paneId: 'fy-session-1' },
      },
      {
        name: 'the zeroth pane, which tmux never issues',
        schema: session.SessionAttachTargetSchema,
        value: { ...sessionAttachTarget, paneId: '%0' },
      },
      {
        // pid 1 is init. Attaching to it would mean the pane process is already gone.
        name: 'init as the pane process',
        schema: session.SessionAttachTargetSchema,
        value: { ...sessionAttachTarget, pid: 1 },
      },
      {
        name: 'a pane with no recorded start ticks',
        schema: session.SessionAttachTargetSchema,
        value: { ...sessionAttachTarget, processStartTicks: 0 },
      },
      {
        name: 'an unknown attach field',
        schema: session.SessionAttachTargetSchema,
        value: { ...sessionAttachTarget, windowId: '@1' },
      },
    ];

    // Act + Assert
    assertRejects(cases);
  });

  it('should reject stream frames that would let a heartbeat pass for an event', () => {
    // Arrange
    const cases: SchemaCase[] = [
      {
        name: 'a bare event outside the wrapper',
        schema: session.FyEventStreamFrameSchema,
        value: fyEvent,
      },
      {
        name: 'an event frame carrying a malformed event',
        schema: session.FyEventStreamFrameSchema,
        value: { kind: 'event', event: { ...fyEvent, sequence: -1 } },
      },
      {
        // Zero seconds of silence is not a proof of anything; it would print on every quiet tick.
        name: 'an idle proof of no elapsed silence',
        schema: session.FyEventStreamFrameSchema,
        value: { ...sessionIdleFrame, idleSeconds: 0 },
      },
      {
        name: 'an idle frame that also smuggles an event',
        schema: session.FyEventStreamFrameSchema,
        value: { ...sessionIdleFrame, event: fyEvent },
      },
      {
        name: 'a fleet scope inventing a session id',
        schema: session.FyEventStreamIdleScopeSchema,
        value: { ...fleetIdleFrame.scope, sessionId: 'session-1' },
      },
      {
        name: 'a session scope with no cursor',
        schema: session.FyEventStreamIdleScopeSchema,
        value: { kind: 'session', sessionId: 'session-1' },
      },
      {
        name: 'a scope kind nobody emits',
        schema: session.FyEventStreamIdleScopeSchema,
        value: { kind: 'daemon', after: 0 },
      },
    ];

    // Act + Assert
    assertRejects(cases);
  });
});

describe('service schemas', () => {
  it('should round-trip every public service schema', () => {
    // Arrange
    const cases = serviceCases;

    // Act + Assert
    assertRoundTrips(cases);
    assertCoversEverySchema(service, cases);
  });

  it('should normalize PWA patch input', () => {
    // Arrange
    const input = { name: '  Fleet   View  ', icon: 'f' };

    // Act
    const actual = service.PwaConfigPatchSchema.parse(input);

    // Assert
    should(actual).deepEqual({ name: 'Fleet View', icon: 'F' });
  });

  it('should reject invalid cgroup, PWA, attachment, and scratch correlations', () => {
    // Arrange
    const extraction = { method: 'pdfjs', characters: 5, truncated: false, totalPages: 1, pagesRead: 1 };
    const failure = { code: 'unreadable_document', message: 'bad document' };
    const cases: SchemaCase[] = [
      {
        name: 'per-agent limits above fleet',
        schema: service.CgroupConfigSchema,
        value: {
          enabled: true,
          fleet: { cpuPercent: 50, memoryPercent: 50 },
          perAgent: { cpuPercent: 60, memoryPercent: 60 },
        },
      },
      { name: 'empty PWA patch', schema: service.PwaConfigPatchSchema, value: {} },
      {
        name: 'mismatched PDF page fields',
        schema: service.AttachmentViewSchema,
        value: { ...attachmentView, textExtraction: { ...extraction, pagesRead: undefined } },
      },
      {
        name: 'pages read above total',
        schema: service.AttachmentViewSchema,
        value: { ...attachmentView, textExtraction: { ...extraction, pagesRead: 2 } },
      },
      {
        name: 'DOCX with pages',
        schema: service.AttachmentViewSchema,
        value: { ...attachmentView, textExtraction: { ...extraction, method: 'docx-xml' } },
      },
      {
        name: 'success and failure',
        schema: service.AttachmentViewSchema,
        value: { ...attachmentView, textExtraction: extraction, textExtractionFailure: failure },
      },
      {
        name: 'locked with extraction',
        schema: service.AttachmentViewSchema,
        value: { ...attachmentView, textExtraction: extraction, encrypted: { kind: 'pdf', locked: true } },
      },
      {
        name: 'unlocked without expiry',
        schema: service.AttachmentViewSchema,
        value: { ...attachmentView, encrypted: { kind: 'pdf', locked: false, decryptedSize: 4 } },
      },
      {
        name: 'eligible with reason',
        schema: service.ScratchPlanViewSchema,
        value: { ...scratchPlanView, reason: 'still active' },
      },
      {
        name: 'ineligible without reason',
        schema: service.ScratchPlanViewSchema,
        value: { ...scratchPlanView, eligible: false },
      },
    ];

    // Act + Assert
    assertRejects(cases);
  });

  it('should resolve both attachment-encryption and scratch-plan states', () => {
    // Arrange
    const values = [
      { ...attachmentView, encrypted: { kind: 'pdf', locked: true } },
      {
        ...attachmentView,
        encrypted: { kind: 'pdf', locked: false, expiresAt: LATER_INSTANT, decryptedSize: 8 },
      },
    ];

    // Act + Assert
    for (const value of values) should(service.AttachmentViewSchema.safeParse(value).success).be.true();
    should(
      service.ScratchPlanViewSchema.safeParse({ ...scratchPlanView, eligible: false, reason: 'session active' })
        .success,
    ).be.true();
  });
});
