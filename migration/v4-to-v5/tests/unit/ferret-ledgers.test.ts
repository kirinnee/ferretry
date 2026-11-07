import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
  ArchiveDocumentSchema,
  FerretHistoryEventSchema,
  ManagedWorktreeDocumentSchema,
  NamesDocumentSchema,
  SessionForkReceiptSchema,
} from '@ferretry/core-ferrets/contract';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ferretsStep } from '../../src/steps/ferrets.ts';
import { AT, FAKE_HASH, fixture, RUNTIME } from './ferret-fixture.ts';

let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f.clean();
});
const output = async (file: string) => JSON.parse(await readFile(join(f.to, 'state/ferrets', file), 'utf8'));
function forkReceipt() {
  const transcript = {
    v: 1,
    home: join(f.from, 'fleet/homes', RUNTIME),
    file: join(f.from, 'fleet/shared/codex/sessions/conversation.jsonl'),
    identity: 'correlated',
    harnessSessionId: 'conversation',
  } as const;
  return {
    v: 1,
    planId: 'plan1',
    sourceSessionId: 'f1',
    requestId: 'request1',
    requestFingerprint: FAKE_HASH,
    fingerprint: FAKE_HASH,
    targetSessionId: 'child',
    phase: 'claimed',
    phaseHistory: [{ phase: 'claimed', at: AT }],
    report: null,
    createdAt: AT,
    updatedAt: AT,
    plan: {
      v: 1,
      planId: 'plan1',
      preparedAt: AT,
      source: {
        sessionId: 'f1',
        incarnation: 'i1',
        runtimeGeneration: 1,
        harness: 'codex',
        agent: 'codex-work',
        model: null,
        teammate: null,
        name: 'source',
        label: null,
        transcriptProvenance: transcript,
        cutMessagePoint: { v: 1, byteOffset: 0, blockIndex: 0 },
      },
      target: {
        accountId: RUNTIME,
        agent: 'codex-work',
        harness: 'codex',
        model: null,
        effort: null,
        contextWindow: 1000,
      },
      durable: {
        cwd: '/work',
        mode: 'auto',
        parentSessionId: null,
        label: null,
        harnessFlags: [],
        remoteControl: false,
        intervalSeconds: 1,
        timeoutSeconds: 0,
        nudgeAfterSeconds: 0,
        killAfterSeconds: 0,
        directSendMaxChars: 100,
        resumeMenuChoice: 'full',
        maxSnapshots: 1,
        retry: { transientAttempts: 0, stalledAttempts: 0, waitForQuotaReset: false, allowAccountFailover: false },
      },
      facets: {
        conversation: {
          messages: [{ point: { v: 1, byteOffset: 0, blockIndex: 0 }, role: 'user', text: 'FAKE-PRIVATE-MESSAGE' }],
        },
        attachments: { attachments: [] },
        references: { counts: { agent: 0, file: 0, task: 0, attention: 0, skill: 0, terminal: 0, browser: 0 } },
        workspace: { cwd: '/work', head: null, status: null, repositorySnapshot: null },
        lineage: { wardenLineage: false, warden: null },
      },
      notCarried: [],
    },
  } as const;
}

test('keeps journal data and order, callsign claims, archive facts, worktrees, intents and fork receipts', async () => {
  await f.session();
  const events = [1, 2].map(sequence => ({
    schemaVersion: 1,
    sequence,
    sessionId: 'f1',
    time: AT,
    type: 'fixture',
    data: { note: 'FAKE-PRIVATE-JOURNAL' },
  }));
  await writeFile(
    join(f.from, 'state/sessions/f1/events.jsonl'),
    events.map(event => JSON.stringify(event)).join('\n') + '\n',
  );
  const claims = [{ callsign: 'ferret-one', ownerId: 'f1', claimedAtMs: 1, expiresAtMs: 2 }];
  await f.put('state/callsigns.json', claims);
  const sessions = {
    f1: {
      archivedAt: AT,
      name: 'ferret-one',
      configCreatedAt: AT,
      configUpdatedAt: AT,
      status: 'completed',
      createdAt: AT,
      updatedAt: AT,
      lastSequence: 2,
      journalLine: 2,
      journal: { device: '1', inode: '2', size: 100, modifiedAtMs: 3 },
    },
  };
  await f.put('state/archived-sessions.json', { version: 1, sessions });
  const common = {
    version: 1 as const,
    path: '/work/tree',
    branch: 'feature',
    repositoryRoot: '/work',
    commonDir: '/work/.git',
    ownershipToken: 'FAKE-OWNERSHIP-MARKER',
    initialHead: 'abc',
    branchPreexisted: false,
    sourceCwd: '/work',
    relativeCwd: '',
    ownerSessionId: 'f1',
  };
  const worktrees = [{ ...common, gitDir: '/work/.git/worktrees/tree', createdAt: AT }];
  const intents = [{ ...common, path: '/work/pending', declaredAt: AT }];
  await f.put('state/worktrees.json', { version: 1, worktrees, intents });
  const fork = forkReceipt();
  await f.put('state/forks/plan1.json', fork);
  const report = await ferretsStep.run(f.ctx());
  expect(report.status).toBe('converted');
  const lines = (await readFile(join(f.to, 'state/ferrets/f1/history.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map(line => FerretHistoryEventSchema.parse(JSON.parse(line)));
  expect(lines.map(event => event.sequence)).toEqual([1, 2]);
  expect(lines[1]?.data).toEqual(events[1]?.data);
  for (const file of ['names.json', 'archive.json', 'worktrees.json', 'forks/plan1.json']) {
    expect((await output(file)).format).toBe(1);
    expect((await stat(join(f.to, 'state/ferrets', file))).mode & 0o777).toBe(0o600);
  }
  const { format: _namesFormat, ...namesBody } = await output('names.json');
  expect(NamesDocumentSchema.parse(namesBody).claims).toEqual(claims);
  const { format: _archiveFormat, ...archiveBody } = await output('archive.json');
  expect(ArchiveDocumentSchema.parse(archiveBody).sessions).toEqual(sessions);
  const { format: _registryFormat, ...registryBody } = await output('worktrees.json');
  expect(ManagedWorktreeDocumentSchema.parse(registryBody)).toEqual({ worktrees, intents });
  const { format: _forkFormat, ...forkBody } = await output('forks/plan1.json');
  expect(SessionForkReceiptSchema.parse(forkBody)).toEqual(fork);
  expect(forkBody.v).toBe(1);
  expect(JSON.stringify(report)).not.toContain('FAKE-');
});

test('removes only the v4 boardAccess field before validating a fork and preserves its v and fingerprints', async () => {
  const fork = forkReceipt();
  await f.put('state/forks/plan1.json', {
    ...fork,
    plan: { ...fork.plan, durable: { ...fork.plan.durable, boardAccess: 'FAKE-REMOVED' } },
  });
  expect((await ferretsStep.run(f.ctx())).status).toBe('converted');
  expect((await output('forks/plan1.json')).plan.durable.boardAccess).toBeUndefined();
  expect((await output('forks/plan1.json')).fingerprint).toBe(FAKE_HASH);
});

test('missing registries do not create empty documents and dry run validates without writing', async () => {
  await f.put('state/worktrees.json', { version: 1, worktrees: [] });
  const report = await ferretsStep.run(f.ctx(true));
  expect(report.status).toBe('converted');
  expect(report.kept.every(item => item.count === 0)).toBe(true);
  expect(await stat(f.to).catch(() => undefined)).toBeUndefined();
  expect((await ferretsStep.run(f.ctx())).status).toBe('converted');
  expect((await output('worktrees.json')).intents).toEqual([]);
  expect(await stat(join(f.to, 'state/ferrets/names.json')).catch(() => undefined)).toBeUndefined();
});

test('invalid ledger values fail without exposing any value or writing records', async () => {
  await f.session();
  await f.put('state/callsigns.json', [{ callsign: 'FAKE-INVALID!', ownerId: 'f1', claimedAtMs: 1, expiresAtMs: 2 }]);
  const report = await ferretsStep.run(f.ctx());
  expect(report.status).toBe('failed');
  expect(JSON.stringify(report)).not.toContain('FAKE-');
  expect(await stat(f.to).catch(() => undefined)).toBeUndefined();
});

test('journal identity and duplicate sequences fail without leaking data', async () => {
  await f.session();
  const event = { schemaVersion: 1, sequence: 1, sessionId: 'f1', time: AT, type: 'fixture', data: 'FAKE-PRIVATE' };
  const path = join(f.from, 'state/sessions/f1/events.jsonl');
  for (const events of [[event, event], [{ ...event, sessionId: 'wrong' }]]) {
    await writeFile(path, events.map(item => JSON.stringify(item)).join('\n'));
    const report = await ferretsStep.run(f.ctx());
    expect(report.status).toBe('failed');
    expect(JSON.stringify(report)).not.toContain('FAKE-');
  }
});
