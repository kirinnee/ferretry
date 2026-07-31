import { describe, it } from 'bun:test';
import should from 'should';
import * as learning from '../../src/lib/learning.ts';
import { INSTANT, LATER_INSTANT } from '../fixtures.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

const config = {
  enabled: true,
  agent: 'claude-auto-loge',
  model: 'claude-opus-5',
  intervalMinutes: 30,
  batchSize: 20,
  maxMinersPerRun: 2,
  maxSessionsPerRun: 50,
  minSpawnGapMinutes: 0,
};

const target = { kind: 'global-agent-guidance', path: 'AGENTS.md', anchor: '#shell-commands' };
const historyEntry = { at: INSTANT, event: 'created', by: 'miner', note: 'Mined from two sessions.' };

const proposal = {
  id: 'proposal-1',
  category: 'global',
  state: 'pending',
  title: 'Always run commands through direnv',
  ruleText: 'Run every shell command through `direnv exec .` so the nix shell is loaded.',
  target,
  observationIds: ['obs-1', 'obs-2'],
  occurrences: 2,
  crossRepoCount: 1,
  firstSeen: INSTANT,
  lastSeen: LATER_INSTANT,
  identity: 'direnv-exec',
  history: [historyEntry],
};

const evidence = {
  observationId: 'obs-1',
  sessionId: 'session-1',
  teammate: 'lorretta',
  repo: 'ferretry',
  at: INSTANT,
  quote: 'Use direnv exec for every command.',
  source: 'human',
  kind: 'correction',
};

const proposalView = { ...proposal, evidence: [evidence] };

const runManifest = {
  runId: 'run-1',
  startedAt: INSTANT,
  finishedAt: LATER_INSTANT,
  sessionsScanned: 12,
  sessionsWithSignal: 3,
  minerSessions: ['session-9'],
  observationsProposed: 5,
  observationsVerified: 4,
  rejectedQuotes: 1,
  malformedFiles: 0,
  proposalsCreated: 2,
  proposalsStrengthened: 1,
  proposalsSuppressedByTombstone: 0,
  perHarness: { claude: 2, codex: 1 },
  message: 'Completed without spawning a miner.',
};

const status = {
  enabled: true,
  intervalMinutes: 30,
  watermarkAt: INSTANT,
  lastRunAt: LATER_INSTANT,
  pending: { total: 3, strong: 2, weak: 1 },
  totals: { observations: 9, proposals: 3, tombstones: 1 },
  running: false,
  lastRun: runManifest,
};

const learningCases: SchemaCase[] = [
  { name: 'learning config', schema: learning.LearningConfigSchema, value: config },
  { name: 'observation kind', schema: learning.ObservationKindSchema, value: 'correction' },
  { name: 'observation source', schema: learning.ObservationSourceSchema, value: 'human' },
  { name: 'proposal category', schema: learning.ProposalCategorySchema, value: 'global' },
  { name: 'proposal state', schema: learning.ProposalStateSchema, value: 'pending' },
  { name: 'proposal target', schema: learning.ProposalTargetSchema, value: target },
  { name: 'proposal history entry', schema: learning.ProposalHistoryEntrySchema, value: historyEntry },
  { name: 'proposal', schema: learning.ProposalSchema, value: proposal },
  { name: 'run manifest', schema: learning.RunManifestSchema, value: runManifest },
  { name: 'evidence view', schema: learning.EvidenceViewSchema, value: evidence },
  { name: 'proposal view', schema: learning.ProposalViewSchema, value: proposalView },
  { name: 'learning status', schema: learning.LearningStatusSchema, value: status },
  { name: 'learning action', schema: learning.LearningActionRequestSchema, value: { action: 'accept' } },
  { name: 'learning run request', schema: learning.LearningRunRequestSchema, value: { spawn: true } },
  {
    name: 'learning patch response',
    schema: learning.LearningPatchResponseSchema,
    value: { path: 'AGENTS.md', contents: '# Agents\n' },
  },
];

describe('learning schemas', () => {
  it('should round-trip every public learning schema', () => {
    // Arrange
    const cases = learningCases;

    // Act + Assert
    assertRoundTrips(cases);
    assertCoversEverySchema(learning, cases);
  });

  it('should resolve every observation, proposal, and target enumeration', () => {
    // Arrange
    const kinds = ['correction', 'roadblock', 'preference', 'recurring_task', 'tooling_failure'] as const;
    const sources = ['human', 'teammate'] as const;
    const states = ['pending', 'accepted', 'rejected'] as const;
    const targetKinds = ['global-agent-guidance', 'automation-guidance'] as const;
    const actors = ['miner', 'user'] as const;

    // Act + Assert
    for (const kind of kinds) should(learning.ObservationKindSchema.parse(kind)).equal(kind);
    for (const source of sources) should(learning.ObservationSourceSchema.parse(source)).equal(source);
    for (const state of states) should(learning.ProposalSchema.parse({ ...proposal, state }).state).equal(state);
    for (const kind of targetKinds) {
      should(learning.ProposalTargetSchema.parse({ ...target, kind }).kind).equal(kind);
    }
    for (const by of actors) should(learning.ProposalHistoryEntrySchema.parse({ ...historyEntry, by }).by).equal(by);
    for (const kind of kinds) should(learning.EvidenceViewSchema.parse({ ...evidence, kind }).kind).equal(kind);
    should(learning.ProposalCategorySchema.parse('global')).equal('global');
  });

  it('should resolve every learning action member and default the run request', () => {
    // Arrange
    const actions = [
      { action: 'accept' },
      { action: 'reject' },
      { action: 'reject', note: 'Too narrow to generalise.' },
      { action: 'edit', ruleText: 'Run every command through direnv exec.' },
    ];

    // Act
    const parsed = actions.map(action => learning.LearningActionRequestSchema.parse(action));
    const trimmed = learning.LearningActionRequestSchema.parse({ action: 'edit', ruleText: '  trimmed rule  ' });
    const defaulted = learning.LearningRunRequestSchema.parse({});
    const spawned = learning.LearningRunRequestSchema.parse({ spawn: true });

    // Assert
    should(parsed).deepEqual(actions);
    should(trimmed).deepEqual({ action: 'edit', ruleText: 'trimmed rule' });
    should(defaulted).deepEqual({ spawn: false });
    should(spawned).deepEqual({ spawn: true });
  });

  it('should accept omitted optional fields across config, manifests, and status', () => {
    // Arrange
    const { model: _model, ...configWithoutModel } = config;
    const { finishedAt: _finishedAt, message: _message, ...runningManifest } = runManifest;
    const { anchor: _anchor, ...targetWithoutAnchor } = target;
    const { teammate: _teammate, ...humanEvidence } = evidence;
    const cases: SchemaCase[] = [
      { name: 'config without a model hint', schema: learning.LearningConfigSchema, value: configWithoutModel },
      { name: 'manifest for an in-flight run', schema: learning.RunManifestSchema, value: runningManifest },
      { name: 'target without an anchor', schema: learning.ProposalTargetSchema, value: targetWithoutAnchor },
      {
        name: 'history entry without a note',
        schema: learning.ProposalHistoryEntrySchema,
        value: { at: INSTANT, event: 'accepted', by: 'user' },
      },
      {
        name: 'evidence quoted from the human',
        schema: learning.EvidenceViewSchema,
        value: { ...humanEvidence, source: 'human' },
      },
      {
        name: 'status before the first run',
        schema: learning.LearningStatusSchema,
        value: {
          enabled: false,
          intervalMinutes: 1,
          pending: { total: 0, strong: 0, weak: 0 },
          totals: { observations: 0, proposals: 0, tombstones: 0 },
          running: false,
        },
      },
    ];

    // Act + Assert
    assertRoundTrips(cases);
  });

  it('should accept boundary counts, quotes, and instants', () => {
    // Arrange
    const cases: SchemaCase[] = [
      {
        name: 'smallest legal config',
        schema: learning.LearningConfigSchema,
        value: {
          enabled: false,
          agent: 'a',
          intervalMinutes: 1,
          batchSize: 1,
          maxMinersPerRun: 1,
          maxSessionsPerRun: 1,
          minSpawnGapMinutes: 0,
        },
      },
      {
        name: 'single observation and history entry',
        schema: learning.ProposalSchema,
        value: { ...proposal, observationIds: ['obs-1'], occurrences: 1, crossRepoCount: 1, history: [historyEntry] },
      },
      {
        name: 'proposal seen once at a single instant',
        schema: learning.ProposalSchema,
        value: { ...proposal, firstSeen: INSTANT, lastSeen: INSTANT },
      },
      {
        name: 'proposal spanning offset instants',
        schema: learning.ProposalSchema,
        value: { ...proposal, firstSeen: '2026-07-30T20:00:00+08:00', lastSeen: LATER_INSTANT },
      },
      {
        name: 'quote at the 300-character ceiling',
        schema: learning.EvidenceViewSchema,
        value: { ...evidence, quote: 'q'.repeat(300) },
      },
      { name: 'single-character quote', schema: learning.EvidenceViewSchema, value: { ...evidence, quote: 'q' } },
      {
        name: 'zeroed manifest counters',
        schema: learning.RunManifestSchema,
        value: {
          ...runManifest,
          sessionsScanned: 0,
          sessionsWithSignal: 0,
          minerSessions: [],
          observationsProposed: 0,
          observationsVerified: 0,
          rejectedQuotes: 0,
          malformedFiles: 0,
          proposalsCreated: 0,
          proposalsStrengthened: 0,
          proposalsSuppressedByTombstone: 0,
          perHarness: { claude: 0, codex: 0 },
        },
      },
      {
        name: 'pending split entirely into strong',
        schema: learning.LearningStatusSchema,
        value: { ...status, pending: { total: 2, strong: 2, weak: 0 } },
      },
      {
        name: 'pending split entirely into weak',
        schema: learning.LearningStatusSchema,
        value: { ...status, pending: { total: 2, strong: 0, weak: 2 } },
      },
      {
        name: 'empty patch contents',
        schema: learning.LearningPatchResponseSchema,
        value: { path: 'AGENTS.md', contents: '' },
      },
    ];

    // Act + Assert
    assertRoundTrips(cases);
  });

  it('should reject proposals whose evidence window or identity is incoherent', () => {
    // Arrange
    const cases: SchemaCase[] = [
      {
        name: 'first seen after last seen',
        schema: learning.ProposalSchema,
        value: { ...proposal, firstSeen: LATER_INSTANT, lastSeen: INSTANT },
      },
      {
        name: 'view inheriting the window refinement',
        schema: learning.ProposalViewSchema,
        value: { ...proposalView, firstSeen: LATER_INSTANT, lastSeen: INSTANT },
      },
      { name: 'non-global category', schema: learning.ProposalSchema, value: { ...proposal, category: 'repo' } },
      { name: 'unknown proposal state', schema: learning.ProposalSchema, value: { ...proposal, state: 'archived' } },
      { name: 'no observations', schema: learning.ProposalSchema, value: { ...proposal, observationIds: [] } },
      { name: 'empty observation id', schema: learning.ProposalSchema, value: { ...proposal, observationIds: [''] } },
      { name: 'empty history', schema: learning.ProposalSchema, value: { ...proposal, history: [] } },
      { name: 'zero occurrences', schema: learning.ProposalSchema, value: { ...proposal, occurrences: 0 } },
      {
        name: 'fractional cross-repo count',
        schema: learning.ProposalSchema,
        value: { ...proposal, crossRepoCount: 1.5 },
      },
      { name: 'empty rule text', schema: learning.ProposalSchema, value: { ...proposal, ruleText: '' } },
      { name: 'empty identity', schema: learning.ProposalSchema, value: { ...proposal, identity: '' } },
      {
        name: 'unknown target kind',
        schema: learning.ProposalTargetSchema,
        value: { ...target, kind: 'session-guidance' },
      },
      { name: 'empty target path', schema: learning.ProposalTargetSchema, value: { ...target, path: '' } },
      {
        name: 'unknown history actor',
        schema: learning.ProposalHistoryEntrySchema,
        value: { ...historyEntry, by: 'daemon' },
      },
      {
        name: 'history instant without a timezone',
        schema: learning.ProposalHistoryEntrySchema,
        value: { ...historyEntry, at: '2026-07-30T12:00:00' },
      },
      { name: 'view without evidence', schema: learning.ProposalViewSchema, value: { ...proposal, evidence: [] } },
      {
        name: 'quote past the 300-character ceiling',
        schema: learning.EvidenceViewSchema,
        value: { ...evidence, quote: 'q'.repeat(301) },
      },
      { name: 'empty quote', schema: learning.EvidenceViewSchema, value: { ...evidence, quote: '' } },
      {
        name: 'unknown evidence source',
        schema: learning.EvidenceViewSchema,
        value: { ...evidence, source: 'daemon' },
      },
      {
        name: 'unknown observation kind',
        schema: learning.EvidenceViewSchema,
        value: { ...evidence, kind: 'insight' },
      },
    ];

    // Act + Assert
    assertRejects(cases);
  });

  it('should reject incoherent config, manifests, status, and requests', () => {
    // Arrange
    const cases: SchemaCase[] = [
      { name: 'zero interval', schema: learning.LearningConfigSchema, value: { ...config, intervalMinutes: 0 } },
      { name: 'fractional batch size', schema: learning.LearningConfigSchema, value: { ...config, batchSize: 2.5 } },
      {
        name: 'negative spawn gap',
        schema: learning.LearningConfigSchema,
        value: { ...config, minSpawnGapMinutes: -1 },
      },
      { name: 'empty agent name', schema: learning.LearningConfigSchema, value: { ...config, agent: '' } },
      {
        name: 'manifest missing a harness tally',
        schema: learning.RunManifestSchema,
        value: { ...runManifest, perHarness: { claude: 1 } },
      },
      {
        name: 'manifest counting an unknown harness',
        schema: learning.RunManifestSchema,
        value: { ...runManifest, perHarness: { claude: 1, codex: 1, gemini: 1 } },
      },
      {
        name: 'negative manifest counter',
        schema: learning.RunManifestSchema,
        value: { ...runManifest, rejectedQuotes: -1 },
      },
      { name: 'empty run id', schema: learning.RunManifestSchema, value: { ...runManifest, runId: '' } },
      {
        name: 'manifest instant without a timezone',
        schema: learning.RunManifestSchema,
        value: { ...runManifest, startedAt: '2026-07-30 12:00:00' },
      },
      {
        name: 'pending total above its parts',
        schema: learning.LearningStatusSchema,
        value: { ...status, pending: { total: 4, strong: 2, weak: 1 } },
      },
      {
        name: 'pending total below its parts',
        schema: learning.LearningStatusSchema,
        value: { ...status, pending: { total: 2, strong: 2, weak: 1 } },
      },
      {
        name: 'negative pending count',
        schema: learning.LearningStatusSchema,
        value: { ...status, pending: { total: 1, strong: 2, weak: -1 } },
      },
      {
        name: 'status carrying a malformed last run',
        schema: learning.LearningStatusSchema,
        value: { ...status, lastRun: { ...runManifest, perHarness: {} } },
      },
      { name: 'unknown action', schema: learning.LearningActionRequestSchema, value: { action: 'defer' } },
      {
        name: 'accept carrying a note',
        schema: learning.LearningActionRequestSchema,
        value: { action: 'accept', note: 'looks fine' },
      },
      {
        name: 'reject with an empty note',
        schema: learning.LearningActionRequestSchema,
        value: { action: 'reject', note: '' },
      },
      { name: 'edit without rule text', schema: learning.LearningActionRequestSchema, value: { action: 'edit' } },
      {
        name: 'edit with whitespace-only rule text',
        schema: learning.LearningActionRequestSchema,
        value: { action: 'edit', ruleText: '   ' },
      },
      {
        name: 'edit carrying a stray field',
        schema: learning.LearningActionRequestSchema,
        value: { action: 'edit', ruleText: 'rule', note: 'why' },
      },
      {
        name: 'run request with an unknown field',
        schema: learning.LearningRunRequestSchema,
        value: { spawn: true, force: true },
      },
      {
        name: 'run request with a non-boolean spawn',
        schema: learning.LearningRunRequestSchema,
        value: { spawn: 'yes' },
      },
      {
        name: 'patch response without a path',
        schema: learning.LearningPatchResponseSchema,
        value: { path: '', contents: 'x' },
      },
    ];

    // Act + Assert
    assertRejects(cases);
  });
});
