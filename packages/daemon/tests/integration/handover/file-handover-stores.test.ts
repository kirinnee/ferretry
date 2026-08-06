import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'bun:test';
import type { SessionHandoverReceipt, SessionTransferPlan } from '@ferretry/protocol';
import should from 'should';
import { FileHandoverReceiptStore } from '../../../src/adapters/handover/file-handover-receipt-store.ts';
import { handoverPlanId } from '../../../src/lib/handover/policy.ts';
import { HandoverReceiptDamagedError } from '../../../src/lib/handover/types.ts';

const AT = '2026-02-01T00:00:00.000Z';
const PLAN_ID = handoverPlanId('source-1', 'req-1');

const ACCOUNT = {
  accountId: 'acct-codex',
  agent: 'codex-main',
  harness: 'codex',
  model: null,
  effort: null,
  contextWindow: 400_000,
} as const;

let home = '';
let sessions = '';

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'fy-handover-'));
  sessions = join(home, 'state', 'sessions');
  await mkdir(join(sessions, 'source-1'), { recursive: true });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function receipt(overrides: Partial<SessionHandoverReceipt> = {}): SessionHandoverReceipt {
  return {
    requestId: 'req-1',
    fingerprint: 'fp',
    sourceSessionId: 'source-1',
    sourceHarness: 'claude',
    sourceAgent: 'claude-main',
    reason: 'the claude account is out of quota',
    resolvedTarget: { replacement: ACCOUNT, coordinator: null },
    planId: PLAN_ID,
    plan: plan(),
    board: null,
    phase: 'requested',
    phaseHistory: [{ phase: 'requested', at: AT }],
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

function plan(planId = PLAN_ID): SessionTransferPlan {
  return {
    v: 1,
    planId,
    preparedAt: AT,
    source: {
      sessionId: 'source-1',
      incarnation: 'source-1-1',
      runtimeGeneration: 1,
      harness: 'claude',
      agent: 'claude-main',
      model: null,
      teammate: null,
      name: 'ada',
      label: null,
      transcriptProvenance: null,
      cutMessagePoint: null,
    },
    target: {
      accountId: 'acct-codex',
      agent: 'codex-main',
      harness: 'codex',
      model: null,
      effort: null,
      contextWindow: 400_000,
    },
    durable: {
      cwd: '/work/repo',
      mode: 'interactive',
      parentSessionId: null,
      boardAccess: 'none',
      label: null,
      harnessFlags: [],
      remoteControl: false,
      intervalSeconds: 30,
      timeoutSeconds: 0,
      nudgeAfterSeconds: 0,
      killAfterSeconds: 0,
      directSendMaxChars: 4000,
      resumeMenuChoice: 'full',
      maxSnapshots: 5,
      retry: { transientAttempts: 0, stalledAttempts: 0, waitForQuotaReset: false, allowAccountFailover: false },
    },
    facets: {
      conversation: null,
      attachments: { attachments: [] },
      references: { counts: { agent: 0, file: 0, task: 0, attention: 0, skill: 0, terminal: 0, browser: 0 } },
      workspace: { cwd: '/work/repo', head: null, status: null, repositorySnapshot: null },
      lineage: { wardenLineage: false, warden: null },
    },
    notCarried: [],
  };
}

describe('FileHandoverReceiptStore', () => {
  it('round-trips a receipt through an atomic write, leaving no temporary behind', async () => {
    const store = new FileHandoverReceiptStore(sessions, () => 'fixed');
    should(await store.read('source-1')).be.null();
    await store.write(receipt());
    should(await store.read('source-1')).deepEqual(receipt());
    await should(stat(`${store.file('source-1')}.fixed.tmp`)).be.rejected();
    should((await stat(store.file('source-1'))).mode & 0o777).equal(0o600);
  });

  it('parses on the way out, so this daemon cannot write a document a later one refuses', async () => {
    const store = new FileHandoverReceiptStore(sessions);
    // A history that does not end at the current phase is exactly what the durable schema forbids.
    await should(store.write(receipt({ phase: 'invited' }))).be.rejected();
    should(await store.read('source-1')).be.null();
  });

  it('refuses a damaged document rather than reading it as absence', async () => {
    const store = new FileHandoverReceiptStore(sessions);
    await writeFile(store.file('source-1'), '{ not json', 'utf8');
    await should(store.read('source-1')).be.rejectedWith(HandoverReceiptDamagedError);
    await writeFile(store.file('source-1'), JSON.stringify({ requestId: 'req-1' }), 'utf8');
    const error = await store.read('source-1').catch((thrown: unknown) => thrown);
    should(error).be.instanceof(HandoverReceiptDamagedError);
    should((error as HandoverReceiptDamagedError).file).equal(store.file('source-1'));
  });

  it('refuses a read the filesystem answered with anything but absence', async () => {
    const store = new FileHandoverReceiptStore(sessions);
    // A directory where the document should be: readable path, unreadable document.
    await mkdir(store.file('source-1'));
    await should(store.read('source-1')).be.rejectedWith(HandoverReceiptDamagedError);
  });

  it('lists only the sessions whose handover has not finished', async () => {
    const store = new FileHandoverReceiptStore(sessions);
    await mkdir(join(sessions, 'source-2'), { recursive: true });
    await mkdir(join(sessions, 'source-3'), { recursive: true });
    await writeFile(join(sessions, 'not-a-session'), 'a file, not a directory', 'utf8');
    await store.write(receipt());
    await store.write(
      receipt({
        sourceSessionId: 'source-2',
        planId: handoverPlanId('source-2', 'req-1'),
        plan: {
          ...plan(handoverPlanId('source-2', 'req-1')),
          source: { ...plan().source, sessionId: 'source-2' },
        },
        phase: 'refused',
        phaseHistory: [
          { phase: 'requested', at: AT },
          { phase: 'refused', at: AT },
        ],
        refusal: { failure: 'board_busy', message: 'the board already carries an outstanding invitation' },
      }),
    );
    should(await store.pendingSourceSessionIds()).deepEqual(['source-1']);
  });

  it('refuses a receipt found in another session directory, and keeps it off the roster', async () => {
    const store = new FileHandoverReceiptStore(sessions);
    await mkdir(join(sessions, 'source-2'), { recursive: true });
    await writeFile(join(sessions, 'source-2', 'handover.json'), JSON.stringify(receipt()), 'utf8');
    await should(store.read('source-2')).be.rejectedWith(HandoverReceiptDamagedError);
    await should(store.pendingSourceSessionIds()).be.rejectedWith(HandoverReceiptDamagedError);
  });

  it('refuses a receipt whose plan id is not the one its own source and request derive', async () => {
    const store = new FileHandoverReceiptStore(sessions);
    const forged = handoverPlanId('somebody-else', 'req-1');
    await writeFile(
      store.file('source-1'),
      // Both copies agree with each other, which is exactly what a swapped plan would look like.
      JSON.stringify(receipt({ planId: forged, plan: plan(forged) })),
      'utf8',
    );
    const error = await store.read('source-1').catch((thrown: unknown) => thrown);
    should(error).be.instanceof(HandoverReceiptDamagedError);
    should((error as HandoverReceiptDamagedError).detail).match(/is not the one handover req-1 of source-1 derives/u);
  });

  it('refuses to build a path out of a session id it does not recognise', () => {
    const store = new FileHandoverReceiptStore(sessions);
    should(() => store.file('../escape')).throw(/not a session id/u);
    should(() => store.file('')).throw(/not a session id/u);
  });

  it('answers an empty roster when no sessions directory exists yet', async () => {
    const store = new FileHandoverReceiptStore(join(home, 'state', 'nothing-here'));
    should(await store.pendingSourceSessionIds()).be.empty();
  });
});
