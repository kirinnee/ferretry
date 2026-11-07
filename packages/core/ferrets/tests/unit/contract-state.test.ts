import { describe, expect, test } from 'bun:test';
import { MemoryStateFolder } from '@ferretry/kernel/testing';
import {
  ArchiveFile,
  FerretFiles,
  FerretHistoryFiles,
  FerretRecordSchema,
  FerretSummarySchema,
  ForkFiles,
  SessionProvenanceSchema,
  SessionTransferEdgeSchema,
  TranscriptProvenanceSchema,
  WorktreesFile,
} from '../../contract/index.ts';

/**
 * Each declared Ferrets file reads today's document (the shapes the v4 → v5 converter writes) and refuses a damaged
 * one as damage, never as empty. Samples are today's fixtures (`packages/daemon/tests/unit/{fork,transfer}`).
 */

const AT = '2026-08-06T07:00:00.000Z';
const folder = () => new MemoryStateFolder();
const port = (state: MemoryStateFolder) =>
  state.port([FerretFiles, FerretHistoryFiles, ArchiveFile, WorktreesFile, ForkFiles]);
const stamped = (body: object) => JSON.stringify({ format: 1, ...body });

const PROVENANCE = {
  v: 1,
  home: '/home/agent/.claude',
  identity: 'minted',
  harnessSessionId: 'harness-1',
  file: '/home/agent/.claude/projects/x/harness-1.jsonl',
};

describe('history.jsonl', () => {
  const event = {
    schemaVersion: 1,
    sequence: 1,
    sessionId: 'mi4abc-1a2b3c4d',
    time: AT,
    type: 'session.stopped',
    data: { reason: 'done' },
  };

  test('today’s stored journal events read back, line by line', async () => {
    const state = folder();
    state.plant(
      FerretHistoryFiles,
      `${stamped(event)}\n${stamped({ ...event, sequence: 2, type: 'session.resumed', data: {} })}\n`,
      'f1',
    );
    const lines: unknown[] = [];
    for await (const line of port(state).lines(FerretHistoryFiles, 'f1')) lines.push(line);
    expect(lines).toEqual([event, { ...event, sequence: 2, type: 'session.resumed', data: {} }]);
  });

  test('a line that is not today’s event shape is damage: skipped and counted, the rest still read', async () => {
    for (const bad of [
      { ...event, sequence: 0 },
      { ...event, sessionId: 'Upper' },
      { ...event, type: ' padded ' },
      { ...event, extra: true },
    ]) {
      const state = folder();
      state.plant(FerretHistoryFiles, `${stamped(bad)}\n${stamped(event)}\n`, 'f1');
      const lines: unknown[] = [];
      for await (const line of port(state).lines(FerretHistoryFiles, 'f1')) lines.push(line);
      expect(lines).toEqual([event]);
      const read = await port(state).records(FerretHistoryFiles, 'f1');
      expect(read.unreadable).toBe(1);
      expect([...read.records] as unknown[]).toEqual([event]);
    }
  });
});

describe('archive.json', () => {
  const entry = {
    archivedAt: AT,
    name: 'hadi',
    configCreatedAt: AT,
    configUpdatedAt: AT,
    status: 'completed',
    createdAt: AT,
    updatedAt: AT,
    lastSequence: 12,
    journalLine: 13,
    journal: { device: 'state', inode: 'history', size: 12, modifiedAtMs: 0 },
  };

  test('today’s archive registry body reads back; format is the kernel’s, not a version field', async () => {
    const state = folder();
    state.plant(ArchiveFile, stamped({ sessions: { 'mi4abc-1a2b3c4d': entry } }));
    expect(await port(state).read(ArchiveFile)).toEqual({
      ok: true,
      value: { sessions: { 'mi4abc-1a2b3c4d': entry } },
    });
  });

  test('today’s `version: 1`, a torn file and a bad entry are damage', async () => {
    for (const text of [
      stamped({ version: 1, sessions: {} }),
      '{ torn',
      stamped({ sessions: { s: { ...entry, journalLine: 0 } } }),
      stamped({ sessions: { s: { ...entry, archivedAt: 'yesterday' } } }),
    ]) {
      const state = folder();
      state.plant(ArchiveFile, text);
      expect((await port(state).read(ArchiveFile)).ok).toBe(false);
    }
  });
});

describe('worktrees.json', () => {
  const record = {
    version: 1,
    path: '/home/owner/.ferretry/worktrees/repo/feat-one',
    branch: 'feat/one',
    repositoryRoot: '/work/repo',
    commonDir: '/work/repo/.git',
    gitDir: '/work/repo/.git/worktrees/feat-one',
    ownershipToken: 'token-1',
    createdAt: AT,
    initialHead: 'abc123',
    branchPreexisted: false,
    sourceCwd: '/work/repo',
    relativeCwd: '',
    ownerSessionId: 'mi4abc-1a2b3c4d',
  };
  const { gitDir: _gitDir, createdAt: _createdAt, ...intentBase } = record;
  const intent = { ...intentBase, declaredAt: AT };

  test('today’s managed worktree document reads back', async () => {
    const state = folder();
    state.plant(WorktreesFile, stamped({ worktrees: [record], intents: [intent] }));
    expect(await port(state).read(WorktreesFile)).toEqual({
      ok: true,
      value: { worktrees: [record], intents: [intent] },
    } as never);
  });

  test('missing intents, a record of another version and an unknown field are damage', async () => {
    for (const body of [
      { worktrees: [record] },
      { worktrees: [{ ...record, version: 2 }], intents: [] },
      { worktrees: [{ ...record, owner: 'x' }], intents: [] },
    ]) {
      const state = folder();
      state.plant(WorktreesFile, stamped(body));
      expect((await port(state).read(WorktreesFile)).ok).toBe(false);
    }
  });
});

describe('forks/<planId>.json', () => {
  const planId = 'a'.repeat(64);
  const plan = {
    v: 1,
    planId,
    preparedAt: AT,
    source: {
      sessionId: 'source-a',
      incarnation: 'inc-1',
      runtimeGeneration: 3,
      harness: 'claude',
      agent: 'account-a',
      model: 'opus',
      teammate: null,
      name: 'zelda',
      label: 'teammate',
      transcriptProvenance: PROVENANCE,
      cutMessagePoint: { v: 1, byteOffset: 512, blockIndex: 0 },
    },
    target: {
      accountId: 'account-b',
      agent: 'account-b',
      harness: 'codex',
      model: 'gpt',
      effort: 'high',
      contextWindow: 200_000,
    },
    durable: {
      cwd: '/work/repo',
      mode: 'auto',
      parentSessionId: null,
      label: 'teammate',
      harnessFlags: [],
      remoteControl: true,
      intervalSeconds: 30,
      timeoutSeconds: 600,
      nudgeAfterSeconds: 120,
      killAfterSeconds: 900,
      directSendMaxChars: 4000,
      resumeMenuChoice: 'full',
      maxSnapshots: 5,
      retry: { transientAttempts: 2, stalledAttempts: 1, waitForQuotaReset: true, allowAccountFailover: false },
    },
    facets: {
      conversation: {
        messages: [{ point: { v: 1, byteOffset: 512, blockIndex: 0 }, role: 'user', text: 'ship it', timestamp: AT }],
      },
      attachments: { attachments: [] },
      references: { counts: { agent: 0, file: 0, task: 0, attention: 0, skill: 0, terminal: 0, browser: 0 } },
      workspace: { cwd: '/work/repo', head: 'abc123', status: null, repositorySnapshot: null },
      lineage: { wardenLineage: false, warden: null },
    },
    notCarried: [],
  };
  const LATER = '2026-08-06T07:05:00.000Z';
  const receipt = {
    v: 1,
    planId,
    sourceSessionId: 'source-a',
    requestId: 'req-1',
    requestFingerprint: 'b'.repeat(64),
    fingerprint: 'c'.repeat(64),
    targetSessionId: 'target-1',
    plan,
    phase: 'imported',
    phaseHistory: [
      { phase: 'claimed', at: AT },
      { phase: 'target_created', at: AT },
      { phase: 'plan_persisted', at: AT },
      { phase: 'imported', at: LATER },
    ],
    report: { briefPath: '/state/sessions/target-1/turns/turn-001.md', copiedAttachmentIds: [`att_${'a'.repeat(64)}`] },
    createdAt: AT,
    updatedAt: LATER,
  };

  test('today’s fork receipt reads back', async () => {
    const state = folder();
    state.plant(ForkFiles, stamped(receipt), planId);
    const read = await port(state).read(ForkFiles, planId);
    expect(read.ok).toBe(true);
  });

  test('a skipped phase, a report before the import, a fork into its own source or a plan without its cut is damage', async () => {
    for (const bad of [
      { ...receipt, phaseHistory: [receipt.phaseHistory[0], receipt.phaseHistory[3]] },
      { ...receipt, phase: 'plan_persisted', phaseHistory: receipt.phaseHistory.slice(0, 3), updatedAt: AT },
      { ...receipt, targetSessionId: 'source-a' },
      { ...receipt, plan: { ...plan, source: { ...plan.source, cutMessagePoint: null } } },
      { ...receipt, plan: { ...plan, durable: { ...plan.durable, boardAccess: 'all' } } },
    ]) {
      const state = folder();
      state.plant(ForkFiles, stamped(bad), planId);
      expect((await port(state).read(ForkFiles, planId)).ok).toBe(false);
    }
  });
});

describe('ferret.json: today’s provenance, transfer lineage, project and transcript', () => {
  const record = {
    format: 1,
    id: 'f1',
    name: 'Fern',
    role: 'helper',
    harness: 'codex',
    runner: 'tmux',
    folder: '/work/project',
    state: 'working',
    createdAt: '2026-11-07T12:00:00.000Z',
    stateAt: '2026-11-07T12:00:00.000Z',
    provenance: { v: 1, at: AT, origin: 'session', parent: 'lead', wardenLineage: false, lineageSource: 'none' },
    transferredFrom: {
      v: 1,
      kind: 'fork',
      sourceSessionId: 'source-a',
      sourceIncarnation: 'inc-1',
      sourceHarness: 'claude',
      cutMessagePoint: { v: 1, byteOffset: 512, blockIndex: 0 },
      planId: 'a'.repeat(64),
      at: AT,
    },
    projectId: 'unfiled',
    transcript: { ...PROVENANCE, baseline: ['old-1'] },
  };

  test('a record with all four reads; the summary shows them, the transcript without its baseline', async () => {
    const state = folder();
    state.plant(FerretFiles, JSON.stringify(record), 'f1');
    const read = await port(state).read(FerretFiles, 'f1');
    expect(read.ok).toBe(true);
    const { format: _format, ...body } = record;
    const summary = FerretSummarySchema.parse(body);
    expect(summary.projectId).toBe('unfiled');
    expect(summary.provenance?.origin).toBe('session');
    expect(summary.transcript).toEqual(PROVENANCE as never);
    expect(FerretRecordSchema.safeParse({ ...record, projectId: '6f1c1f9a-8a7e-4a43-9a52-2d0a3c1b5e6f' }).success).toBe(
      true,
    );
  });

  test('a half-true provenance stamp, a handover with a cut, an unknown project or an unidentified transcript file is refused', () => {
    expect(SessionProvenanceSchema.safeParse({ ...record.provenance, wardenLineage: true }).success).toBe(false);
    expect(SessionTransferEdgeSchema.safeParse({ ...record.transferredFrom, kind: 'handover' }).success).toBe(false);
    expect(TranscriptProvenanceSchema.safeParse({ ...PROVENANCE, identity: 'undiscovered' }).success).toBe(false);
    for (const bad of [{ projectId: 'my-project' }, { provenance: { ...record.provenance, origin: 'warden' } }])
      expect(FerretRecordSchema.safeParse({ ...record, ...bad }).success).toBe(false);
  });
});
