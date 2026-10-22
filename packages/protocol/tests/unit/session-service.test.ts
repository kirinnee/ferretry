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
  liveFrame,
  pwaConfigView,
  scratchPlanView,
  scratchSweepView,
  sessionAttachTarget,
  sessionIdleFrame,
  sessionView,
  usageFeedView,
} from '../fixtures.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

const launchInstructions = {
  sections: [
    { id: 'tools', chars: 512 },
    { id: 'settings', chars: 420 },
    { id: 'hypermedia', chars: 1100 },
  ],
  mode: 'interactive',
  questions: true,
};

/** A conversion summary with every count present, for the cross-harness preview schemas. */
const CONVERSION_SUMMARY = {
  converter: 1,
  sourceHarness: 'claude',
  sourceVersion: '2.1.281',
  targetHarness: 'codex',
  targetVersion: '0.163.0',
  turns: 4,
  keptTurns: 4,
  omittedTurns: 0,
  cutNewest: false,
  messages: 8,
  nativeToolCalls: 1,
  toolCallsAsText: 2,
  attachments: 1,
  dropped: { reasoning: 1, sidechains: 0, internal: 4, compactions: 0 },
  estimatedTokens: 120,
  budgetTokens: 154_800,
};

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

const transferredFrom = {
  v: 1,
  kind: 'fork',
  sourceSessionId: 'session-source',
  sourceIncarnation: 'session-source-2',
  sourceHarness: 'claude',
  cutMessagePoint: { v: 1, byteOffset: 128, blockIndex: 1 },
  planId: 'transfer-plan-1',
  at: INSTANT,
};

/**
 * A warden descendant's stamp: the shape whose whole job is to still be true after the warden that
 * caused it has been pruned.
 */
const spawnProvenance = {
  v: 1,
  at: INSTANT,
  origin: 'warden',
  parent: 'warden-7',
  warden: 'warden-7',
  wardenLineage: true,
  lineageSource: 'parent_stamp',
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
  { name: 'send reason', schema: session.SendUnaccountedReasonSchema, value: 'not_delivered' },
  { name: 'send sender kind', schema: session.SendSenderKindSchema, value: 'agent' },
  { name: 'send queue proof', schema: session.SendQueueProofSchema, value: 'transcript' },
  { name: 'send retry', schema: session.SendRetryRequestSchema, value: { force: true } },
  { name: 'send cancel', schema: session.SendCancelRequestSchema, value: {} },
  { name: 'send submit', schema: session.SendSubmitRequestSchema, value: {} },
  {
    name: 'composer draft request',
    schema: session.ComposerDraftRequestSchema,
    value: { action: 'clear', draft: 'fix the login bug' },
  },
  { name: 'composer draft outcome', schema: session.ComposerDraftOutcomeSchema, value: 'changed' },
  {
    name: 'composer draft result',
    schema: session.ComposerDraftResultSchema,
    value: { action: 'submit', outcome: 'submitted' },
  },
  { name: 'send cancel effect', schema: session.SendCancelEffectSchema, value: 'left_in_queue' },
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
  { name: 'session turn state', schema: session.SessionTurnStateSchema, value: 'your-turn' },
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
  {
    name: 'session config with transfer lineage',
    schema: session.SessionConfigSchema,
    value: { ...sessionView.config, transferredFrom },
  },
  { name: 'spawn origin', schema: session.SessionSpawnOriginSchema, value: 'warden' },
  { name: 'warden lineage source', schema: session.WardenLineageSourceSchema, value: 'parent_stamp' },
  { name: 'spawn provenance', schema: session.SessionProvenanceSchema, value: spawnProvenance },
  {
    name: 'unshielded spawn provenance',
    schema: session.SessionProvenanceSchema,
    value: { v: 1, at: INSTANT, origin: 'human', wardenLineage: false, lineageSource: 'none' },
  },
  {
    name: 'session config with a spawn stamp',
    schema: session.SessionConfigSchema,
    value: { ...sessionView.config, provenance: spawnProvenance },
  },
  // The same document with NO stamp: "nobody has decided" is a different answer from "not a
  // descendant", and both have to parse.
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
  { name: 'launch instruction section id', schema: session.LaunchInstructionSectionIdSchema, value: 'hypermedia' },
  {
    name: 'launch instruction section',
    schema: session.LaunchInstructionSectionSchema,
    value: { id: 'tools', chars: 512 },
  },
  { name: 'launch instructions', schema: session.SessionLaunchInstructionsSchema, value: launchInstructions },
  {
    name: 'session state with launch instructions',
    schema: session.SessionStateSchema,
    value: { ...sessionView.state, launchInstructions },
  },
  { name: 'session view', schema: session.SessionViewSchema, value: sessionView },
  {
    name: 'session view with its journal position',
    schema: session.SessionViewSchema,
    value: { ...sessionView, journalSequence: 2_000 },
  },
  { name: 'session list', schema: session.SessionListSchema, value: [sessionView] },
  {
    name: 'session config with launch settings',
    schema: session.SessionConfigSchema,
    value: { ...sessionView.config, launchSettings: 'a1b2c3' },
  },
  { name: 'relaunch drift', schema: session.SessionRelaunchDriftSchema, value: 'settings' },
  {
    name: 'relaunch settings',
    schema: session.SessionRelaunchSettingsSchema,
    value: { current: false, reasons: ['arguments', 'settings'] },
  },
  { name: 'attach target', schema: session.SessionAttachTargetSchema, value: sessionAttachTarget },
  { name: 'console input', schema: session.SessionConsoleInputRequestSchema, value: { data: 'ls\r' } },
  { name: 'console input result', schema: session.SessionConsoleInputResultSchema, value: { written: 3 } },
  { name: 'name suggestions', schema: session.NameSuggestionsSchema, value: ['Ada'] },
  { name: 'event source', schema: session.FyEventSourceSchema, value: 'daemon' },
  { name: 'event', schema: session.FyEventSchema, value: fyEvent },
  { name: 'event list', schema: session.FyEventListSchema, value: [fyEvent] },
  { name: 'session idle scope', schema: session.FyEventStreamIdleScopeSchema, value: sessionIdleFrame.scope },
  { name: 'fleet idle scope', schema: session.FyEventStreamIdleScopeSchema, value: fleetIdleFrame.scope },
  { name: 'event frame', schema: session.FyEventStreamFrameSchema, value: fyEventFrame },
  { name: 'session idle frame', schema: session.FyEventStreamFrameSchema, value: sessionIdleFrame },
  { name: 'fleet idle frame', schema: session.FyEventStreamFrameSchema, value: fleetIdleFrame },
  { name: 'live frame', schema: session.FyEventStreamFrameSchema, value: liveFrame },
  {
    name: 'start request',
    schema: session.StartSessionRequestSchema,
    value: { agent: 'agent', mode: 'auto', prompt: 'Do work', boardAccess: 'none', effort: 'high' },
  },
  {
    name: 'start request with harness flags',
    schema: session.StartSessionRequestSchema,
    value: {
      agent: 'agent',
      mode: 'interactive',
      boardAccess: 'none',
      harnessFlags: ['--settings', '{"hooks":{}}', ''],
    },
  },
  { name: 'send request', schema: session.SendRequestSchema, value: { message: 'Continue' } },
  {
    name: 'structured question answer',
    schema: session.StructuredQuestionAnswerSchema,
    value: { kind: 'selection', labels: ['Yes', 'Also yes'] },
  },
  {
    name: 'answer request',
    schema: session.AnswerSessionRequestSchema,
    value: {
      toolUseId: 'tool-1',
      labels: [],
      responses: ['Yes', 'Later'],
      answers: [
        { kind: 'selection', labels: ['Yes', 'Also yes'] },
        { kind: 'other', text: 'Later' },
      ],
    },
  },
  { name: 'interrupt request', schema: session.InterruptSessionRequestSchema, value: { toolUseId: 'tool-1' } },
  { name: 'stop request', schema: session.StopSessionRequestSchema, value: { reason: 'done' } },
  { name: 'resume request', schema: session.ResumeSessionRequestSchema, value: { message: 'continue' } },
  {
    name: 'migrate request',
    schema: session.MigrateSessionRequestSchema,
    value: { agent: 'next', allowContextDowngrade: false, forceInflight: true },
  },
  { name: 'migration conversation', schema: session.MigrationConversationSchema, value: 'previous' },
  {
    name: 'migrate request starting fresh',
    schema: session.MigrateSessionRequestSchema,
    value: { agent: 'next', allowContextDowngrade: false, forceInflight: false, conversation: 'fresh' },
  },
  {
    name: 'migrate request converting to the other harness',
    schema: session.MigrateSessionRequestSchema,
    value: { agent: 'codex-a', allowContextDowngrade: false, forceInflight: false, conversation: 'convert' },
  },
  { name: 'conversion preview request', schema: session.ConversionPreviewRequestSchema, value: { agent: 'codex-a' } },
  {
    name: 'conversion dropped counts',
    schema: session.ConversionDroppedSchema,
    value: { reasoning: 1, sidechains: 0, internal: 4, compactions: 0 },
  },
  {
    name: 'conversion summary',
    schema: session.ConversionSummarySchema,
    value: CONVERSION_SUMMARY,
  },
  {
    name: 'ready conversion preview',
    schema: session.ConversionPreviewSchema,
    value: { kind: 'ready', targetAgent: 'codex-a', targetModel: 'gpt-5.5', summary: CONVERSION_SUMMARY },
  },
  {
    name: 'refused conversion preview',
    schema: session.ConversionPreviewSchema,
    value: { kind: 'refused', targetAgent: 'codex-a', reason: 'Too new.' },
  },
  {
    name: 'conversation conversion lineage',
    schema: session.ConversationConversionSchema,
    value: {
      v: 1,
      converter: 1,
      fromHarness: 'claude',
      fromConversation: 'src-1',
      fromFile: '/homes/claude/projects/-w/src-1.jsonl',
      toHarness: 'codex',
      toConversation: 'thread-1',
      at: '2026-10-20T08:00:00.000Z',
      keptTurns: 4,
      omittedTurns: 0,
    },
  },
  {
    name: 'conversation unresumable body',
    schema: session.ConversationUnresumableBodySchema,
    value: { error: 'nothing to resume', code: 'conversation_unresumable' },
  },
  {
    name: 'in-flight item',
    schema: session.InflightItemSchema,
    value: {
      kind: 'process',
      verdict: 'unknown',
      title: 'A program Ferretry doesn’t recognise is running',
      detail: 'some-vendor-tool --watch',
      age: '2m',
      blocks: true,
    },
  },
  {
    name: 'migration refusal',
    schema: session.MigrationRefusalSchema,
    value: { status: 'running', turn: 13, blockedBy: 'unreadable', restartsWithCli: 1, items: [] },
  },
  {
    name: 'context downgrade',
    schema: session.ContextDowngradeSchema,
    value: { model: 'claude-sonnet-5', targetWindow: 200_000, currentWindow: 1_000_000 },
  },
  {
    name: 'context downgrade refused body',
    schema: session.ContextDowngradeRefusedBodySchema,
    value: { error: 'refused', code: 'context_downgrade_refused' },
  },
  {
    name: 'migration refused body',
    schema: session.MigrationRefusedBodySchema,
    value: { error: 'refused: nothing', code: 'migration_refused' },
  },
  { name: 'rename request', schema: session.RenameSessionRequestSchema, value: { name: 'New Name' } },
  { name: 'agent rename', schema: session.RenameSessionRequestSchema, value: { teammate: 'Mary-Jane2' } },
  { name: 'hypermedia switch', schema: session.SessionHypermediaPatchSchema, value: { enabled: false } },
  {
    name: 'hypermedia switch result',
    schema: session.SessionHypermediaPatchResultSchema,
    value: { view: sessionView, restartRequired: true, note: 'Hypermedia is off from the next launch.' },
  },
  {
    name: 'a session config that says hypermedia',
    schema: session.SessionConfigSchema,
    value: { ...sessionView.config, hypermedia: false },
  },
  { name: 'agent name', schema: session.AgentNameSchema, value: 'Hadi' },
  { name: 'send disposition', schema: session.SendDispositionSchema, value: 'delivered' },
  { name: 'send result', schema: session.SendResultSchema, value: { ...sessionView, disposition: 'delivered' } },
  { name: 'signal kind', schema: session.SignalKindSchema, value: 'done' },
  { name: 'signal options', schema: session.SignalOptionsSchema, value: { until: INSTANT } },
  { name: 'snapshot scope', schema: session.SnapshotScopeSchema, value: 'screen' },
  { name: 'signal request', schema: session.SignalSessionRequestSchema, value: { kind: 'done' } },
];

const serviceCases: SchemaCase[] = [
  { name: 'health', schema: service.HealthViewSchema, value: healthView },
  {
    name: 'liveness while starting',
    schema: service.LivenessViewSchema,
    value: {
      status: 'starting',
      version: '1.2.3',
      sessionProtocol: 'ferretry-relay/2',
      uptimeSeconds: 12,
      pid: 4242,
      boot: { phase: 'starting', step: 'mounting subsystems', stepElapsedSeconds: 4, elapsedSeconds: 12 },
      eventLoop: {
        lagMs: 3.5,
        maxLagMs: 812,
        stalls: 1,
        lastStall: { at: '2026-10-21T09:00:00.000Z', durationMs: 812, during: ['boot: mounting subsystems'] },
      },
    },
  },
  { name: 'cgroup limit', schema: service.CgroupLimitSchema, value: { cpuPercent: 50, memoryPercent: 50 } },
  { name: 'cgroup config', schema: service.CgroupConfigSchema, value: cgroupConfigView.config },
  { name: 'cgroup patch', schema: service.CgroupConfigPatchSchema, value: { enabled: false } },
  { name: 'cgroup view', schema: service.CgroupConfigViewSchema, value: cgroupConfigView },
  { name: 'PWA config', schema: service.PwaConfigSchema, value: pwaConfigView.config },
  { name: 'PWA patch', schema: service.PwaConfigPatchSchema, value: { name: 'New Name', icon: 'F' } },
  { name: 'PWA view', schema: service.PwaConfigViewSchema, value: pwaConfigView },
  { name: 'usage account', schema: service.UsageAccountViewSchema, value: usageFeedView.accounts[0] },
  { name: 'usage feed', schema: service.UsageFeedViewSchema, value: usageFeedView },
  { name: 'attachment', schema: service.AttachmentViewSchema, value: attachmentView },
  {
    name: 'attachment upload request',
    schema: service.AttachmentUploadRequestSchema,
    value: { filename: 'report.pdf', mime: 'application/pdf', base64: 'JVBERi0=' },
  },
  { name: 'attachment unlock request', schema: service.AttachmentUnlockRequestSchema, value: { password: 'use-once' } },
  {
    name: 'attachment download',
    schema: service.AttachmentDownloadSchema,
    value: { attachment: attachmentView, base64: 'JVBERi0=' },
  },
  { name: 'scratch entry', schema: service.ScratchEntrySchema, value: scratchPlanView.entries[0] },
  { name: 'scratch plan', schema: service.ScratchPlanViewSchema, value: scratchPlanView },
  { name: 'scratch plans', schema: service.ScratchPlanListSchema, value: [scratchPlanView] },
  { name: 'scratch sweep', schema: service.ScratchSweepViewSchema, value: scratchSweepView },
  { name: 'scratch request', schema: service.ScratchSweepRequestSchema, value: { force: true } },
  { name: 'empty response', schema: service.EmptyResponseSchema, value: undefined },
];

describe('session schemas', () => {
  it('should resolve hypermedia from the switch, else the mode default', () => {
    // Arrange
    const config = (mode: 'auto' | 'interactive', hypermedia?: boolean) => ({
      mode,
      ...(hypermedia === undefined ? {} : { hypermedia }),
    });

    // Act + Assert
    should(session.sessionHypermediaEnabled(config('interactive'))).be.true();
    should(session.sessionHypermediaEnabled(config('auto'))).be.false();
    should(session.sessionHypermediaEnabled(config('auto', true))).be.true();
    should(session.sessionHypermediaEnabled(config('interactive', false))).be.false();
  });

  it('should round-trip every public session schema', () => {
    // Arrange
    const cases = sessionCases;

    // Act + Assert
    assertRoundTrips(cases);
    assertCoversEverySchema(session, cases);
  });

  it('should read the draft back out of a composer_occupied refusal, and out of nothing else', () => {
    // Arrange
    const refusal = { error: 'occupied', code: session.COMPOSER_OCCUPIED_CODE, draft: 'fix the login bug' };

    // Act + Assert
    should(session.composerOccupiedDraft(refusal)).equal('fix the login bug');
    should(session.composerOccupiedDraft({ ...refusal, code: 'send_refused' })).be.undefined();
    should(session.composerOccupiedDraft({ ...refusal, draft: '' })).be.undefined();
    should(session.composerOccupiedDraft('occupied')).be.undefined();
    should(session.unconfirmedSendId({ code: session.SEND_UNCONFIRMED_CODE, sendId: 'send-7' })).equal('send-7');
    should(session.unconfirmedSendId({ code: session.SEND_UNCONFIRMED_CODE, sendId: '' })).be.undefined();
    should(session.unconfirmedSendId({ ...refusal, sendId: 'send-7' })).be.undefined();
    should(session.unconfirmedSendId(undefined)).be.undefined();
    should(session.SendUnaccountedReasonSchema.parse('landing_unconfirmed')).equal('landing_unconfirmed');
    should(session.ComposerDraftRequestSchema.safeParse({ action: 'clear', draft: '' }).success).be.false();
    should(
      session.ComposerDraftRequestSchema.safeParse({ action: 'clear', draft: 'x'.repeat(20_001) }).success,
    ).be.false();
  });

  /**
   * The refinements are what make an inconsistent stamp UNREADABLE rather than half-true, and
   * half-true is the dangerous state. A record claiming descent while naming no warden would shield
   * a session whose ancestry nobody can audit afterwards; a record claiming descent while recording
   * `none` as the source would shield one nothing ever decided about. The reverse disagreements are
   * dangerous too: a warden traceback or origin beside a negative shield is still warden evidence,
   * and consumers must never have to choose which half to trust.
   */
  it('should refuse a spawn stamp whose descent and evidence disagree', () => {
    // Arrange
    const shieldedWithoutEvidence = {
      v: 1,
      at: INSTANT,
      origin: 'warden',
      warden: 'warden-7',
      wardenLineage: true,
      lineageSource: 'none',
    };
    const shieldedWithoutWarden = {
      v: 1,
      at: INSTANT,
      origin: 'warden',
      wardenLineage: true,
      lineageSource: 'parent_stamp',
    };
    // Evidence recorded while claiming no descent is the same disagreement from the other side.
    const evidenceWithoutDescent = {
      v: 1,
      at: INSTANT,
      origin: 'human',
      wardenLineage: false,
      lineageSource: 'self_label',
    };
    const wardenWithoutDescent = {
      v: 1,
      at: INSTANT,
      origin: 'human',
      warden: 'warden-7',
      wardenLineage: false,
      lineageSource: 'none',
    };
    const wardenOriginWithoutDescent = {
      v: 1,
      at: INSTANT,
      origin: 'warden',
      wardenLineage: false,
      lineageSource: 'none',
    };
    const descentWithoutWardenOrigin = {
      v: 1,
      at: INSTANT,
      origin: 'session',
      warden: 'warden-7',
      wardenLineage: true,
      lineageSource: 'parent_stamp',
    };

    // Act + Assert
    assertRejects([
      { name: 'shielded with no evidence', schema: session.SessionProvenanceSchema, value: shieldedWithoutEvidence },
      { name: 'shielded with no warden', schema: session.SessionProvenanceSchema, value: shieldedWithoutWarden },
      { name: 'evidence with no descent', schema: session.SessionProvenanceSchema, value: evidenceWithoutDescent },
      { name: 'warden with no descent', schema: session.SessionProvenanceSchema, value: wardenWithoutDescent },
      {
        name: 'warden origin with no descent',
        schema: session.SessionProvenanceSchema,
        value: wardenOriginWithoutDescent,
      },
      {
        name: 'descent with no warden origin',
        schema: session.SessionProvenanceSchema,
        value: descentWithoutWardenOrigin,
      },
    ]);
  });

  it('should refuse a launch record naming an unknown section, a negative size or no question answer', () => {
    // Arrange
    const unknownSection = { ...launchInstructions, sections: [{ id: 'secret-sauce', chars: 1 }] };
    const negativeSize = { ...launchInstructions, sections: [{ id: 'tools', chars: -1 }] };
    const { questions: _questions, ...noQuestions } = launchInstructions;

    // Act + Assert
    assertRejects([
      { name: 'unknown section', schema: session.SessionLaunchInstructionsSchema, value: unknownSection },
      { name: 'negative size', schema: session.SessionLaunchInstructionsSchema, value: negativeSize },
      { name: 'no question answer', schema: session.SessionLaunchInstructionsSchema, value: noQuestions },
    ]);
  });

  /**
   * A DECLARED optional field that is present and invalid fails the WHOLE parse — Zod strips unknown
   * keys, never invalid declared ones. That is the blast radius the wire widening accepts on purpose:
   * one corrupt stamp takes the session out of every surface at once, rather than quietly handing the
   * warden detector `undefined` for a session that may well be warden-descended.
   */
  it('should refuse an entire session config whose spawn stamp is damaged', () => {
    // Arrange
    const damaged = { ...sessionView.config, provenance: { v: 1, at: INSTANT, origin: 'nonsense' } };

    // Act + Assert
    assertRejects([{ name: 'config with a damaged stamp', schema: session.SessionConfigSchema, value: damaged }]);
  });

  it.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['textual', '12'],
  ])('should refuse a session view whose journal position is %s', (_name, journalSequence) => {
    // Arrange
    const damaged = { ...sessionView, journalSequence };

    // Act + Assert
    assertRejects([
      { name: 'view with a damaged journal position', schema: session.SessionViewSchema, value: damaged },
    ]);
  });

  it('should resolve every runtime-control and signal union member', () => {
    // Arrange
    const controls = [{ action: 'model', model: 'm' }, { action: 'effort', effort: 'high' }, { action: 'compact' }];
    const retiredControls = [{ action: 'clear' }];
    const signals = [
      { kind: 'done', message: 'complete' },
      { kind: 'help', message: 'blocked' },
      { kind: 'waiting', until: INSTANT, condition: 'CI', peer: 'peer-1' },
      { kind: 'working', message: 'resumed' },
    ];

    // Act + Assert
    for (const value of controls) should(session.RuntimeControlRequestSchema.parse(value)).deepEqual(value);
    assertRejects(
      retiredControls.map(value => ({
        name: 'retired runtime control',
        schema: session.RuntimeControlRequestSchema,
        value,
      })),
    );
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
        name: 'conversion preview naming no account',
        schema: session.ConversionPreviewRequestSchema,
        value: { model: 'gpt-5.5' },
      },
      {
        name: 'ready conversion preview with no summary',
        schema: session.ConversionPreviewSchema,
        value: { kind: 'ready', targetAgent: 'codex-a', targetModel: 'gpt-5.5' },
      },
      {
        name: 'migrate request with an unknown conversation choice',
        schema: session.MigrateSessionRequestSchema,
        value: { agent: 'next', conversation: 'guess' },
      },
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
      {
        name: 'empty startup effort',
        schema: session.StartSessionRequestSchema,
        value: { agent: 'agent', mode: 'auto', prompt: 'work', effort: '' },
      },
      {
        name: 'a harness flag holding a control character',
        schema: session.StartSessionRequestSchema,
        value: { agent: 'agent', mode: 'auto', prompt: 'work', harnessFlags: ['--model\nsonnet'] },
      },
      {
        name: 'an over-long harness flag',
        schema: session.StartSessionRequestSchema,
        value: { agent: 'agent', mode: 'auto', prompt: 'work', harnessFlags: ['x'.repeat(16_385)] },
      },
      {
        name: 'too many harness flags',
        schema: session.StartSessionRequestSchema,
        value: { agent: 'agent', mode: 'auto', prompt: 'work', harnessFlags: Array.from({ length: 65 }, () => '-v') },
      },
      {
        name: 'a permission mode outside the closed set',
        schema: session.StartSessionRequestSchema,
        value: { agent: 'agent', mode: 'bypass', prompt: 'work' },
      },
      { name: 'empty rename', schema: session.RenameSessionRequestSchema, value: {} },
      { name: 'a hypermedia switch with no answer', schema: session.SessionHypermediaPatchSchema, value: {} },
      {
        name: 'a hypermedia switch result with no note',
        schema: session.SessionHypermediaPatchResultSchema,
        value: { view: sessionView, restartRequired: false, note: '' },
      },
      { name: 'a name opening with a digit', schema: session.RenameSessionRequestSchema, value: { teammate: '2pac' } },
      { name: 'a name with a space', schema: session.RenameSessionRequestSchema, value: { teammate: 'Mary Jane' } },
      { name: 'a blank name', schema: session.AgentNameSchema, value: '   ' },
      { name: 'an over-long name', schema: session.AgentNameSchema, value: `a${'b'.repeat(32)}` },
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

  it('should bound a Console write to between one character and the documented maximum', () => {
    // Arrange — the longest accepted write, and the three shapes a client must split or not send.
    const longest = 'x'.repeat(session.SESSION_CONSOLE_INPUT_MAX);
    const cases: SchemaCase[] = [
      { name: 'an empty write', schema: session.SessionConsoleInputRequestSchema, value: { data: '' } },
      {
        name: 'a write one past the maximum',
        schema: session.SessionConsoleInputRequestSchema,
        value: { data: `${longest}x` },
      },
      {
        name: 'a write with a field the daemon does not read',
        schema: session.SessionConsoleInputRequestSchema,
        value: { data: 'ls', paneId: '%1' },
      },
      { name: 'a result that wrote nothing', schema: session.SessionConsoleInputResultSchema, value: { written: 0 } },
    ];

    // Act / Assert
    should(session.SessionConsoleInputRequestSchema.parse({ data: longest }).data).have.length(4_096);
    assertRejects(cases);
  });

  it('should reject attach evidence that cannot address exactly one live pane', () => {
    // Arrange — every field here is what stops an attach landing on somebody else's terminal.
    should(session.SessionAttachTargetSchema.parse({ ...sessionAttachTarget, paneId: '%0' }).paneId).equal('%0');
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
        name: 'a pane id that has no numeric value',
        schema: session.SessionAttachTargetSchema,
        value: { ...sessionAttachTarget, paneId: '%' },
      },
      {
        name: 'a zero pane id with a noncanonical leading zero',
        schema: session.SessionAttachTargetSchema,
        value: { ...sessionAttachTarget, paneId: '%00' },
      },
      {
        name: 'a positive pane id with a noncanonical leading zero',
        schema: session.SessionAttachTargetSchema,
        value: { ...sessionAttachTarget, paneId: '%01' },
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
        // The sample is not an event and not a proof: it rides in a wrapper of its own, or a reader
        // that never asked for one could not tell it from a journal entry.
        name: 'a live sample outside the wrapper',
        schema: session.FyEventStreamFrameSchema,
        value: liveFrame.live,
      },
      {
        name: 'a live frame carrying a malformed sample',
        schema: session.FyEventStreamFrameSchema,
        value: { kind: 'live', live: { ...liveFrame.live, outputTokens: -1 } },
      },
      {
        name: 'a live frame that also smuggles an event',
        schema: session.FyEventStreamFrameSchema,
        value: { ...liveFrame, event: fyEvent },
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
