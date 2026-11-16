import { describe, it } from 'bun:test';
import type { StatePort } from '@ferretry/kernel/contract';
import { MemoryStateFolder, SimulatedCrash } from '@ferretry/kernel/testing';
import should from 'should';
import type { SessionTransferPlan } from '../../../../contract/transfer.ts';
import { SessionTransferPlanSchema } from '../../../../contract/transfer.ts';
import { TransferPlanFiles } from '../../../../contract/transfer-state.ts';
import {
  FileSessionTransferTargetPlanStore,
  SessionTransferPlanConflictError,
  SessionTransferPlanCorruptError,
} from '../../../../daemon/adapters/transfer/plan-store.ts';
import { parseSessionId } from '../../../../daemon/lib/session-id.ts';
import { deriveTransferPlanId } from '../../../../daemon/lib/transfer/prepare.ts';

/**
 * The target-session plan copy, over the kernel's state port: installed once and idempotently, refused when a
 * second plan claims the same target, and made durable again on an exact replay.
 *
 * The file mechanics (atomic write, flush of the file and its name, one update chain per file, no write over a
 * damaged document) are the port's and are pinned by the kernel; what is pinned here is the DECISION this store makes
 * on top of them, and that every path that vouches for a plan went through the port's durable write.
 */

const SOURCE = 'source-session';
const REQUEST = 'req-1';
const PLAN_ID = deriveTransferPlanId(SOURCE, REQUEST);

/** Resolves to the rejection reason, failing loudly if the call unexpectedly resolved. */
async function reject(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to reject, but it resolved');
}

function makePlan(overrides: {
  planId?: string;
  preparedAt?: string;
  targetAgent?: string;
  targetAccount?: string;
  targetEffort?: string;
  cutByteOffset?: number;
  messageText?: string;
  durableCwd?: string;
}): SessionTransferPlan {
  return SessionTransferPlanSchema.parse({
    v: 1,
    planId: overrides.planId ?? PLAN_ID,
    preparedAt: overrides.preparedAt ?? '2025-01-01T00:00:00+00:00',
    source: {
      sessionId: SOURCE,
      incarnation: 'inc-1',
      runtimeGeneration: 1,
      harness: 'claude',
      agent: 'claude',
      model: 'sonnet',
      teammate: null,
      name: 'source',
      label: null,
      transcriptProvenance: { v: 1, home: '/home/cl', identity: 'undiscovered' },
      cutMessagePoint: { v: 1, byteOffset: overrides.cutByteOffset ?? 0, blockIndex: 0 },
    },
    target: {
      accountId: overrides.targetAccount ?? 'acc-1',
      agent: overrides.targetAgent ?? 'claude',
      harness: 'claude',
      model: 'sonnet',
      effort: overrides.targetEffort ?? null,
      contextWindow: 200000,
    },
    durable: {
      cwd: overrides.durableCwd ?? '/work',
      mode: 'auto',
      parentSessionId: null,
      label: null,
      harnessFlags: [],
      remoteControl: false,
      intervalSeconds: 1,
      timeoutSeconds: 0,
      nudgeAfterSeconds: 0,
      killAfterSeconds: 0,
      directSendMaxChars: 0,
      resumeMenuChoice: 'full',
      maxSnapshots: 1,
      retry: { transientAttempts: 0, stalledAttempts: 0, waitForQuotaReset: false, allowAccountFailover: false },
    },
    facets: {
      conversation: {
        messages: [
          {
            point: { v: 1, byteOffset: 0, blockIndex: 0 },
            role: 'user',
            text: overrides.messageText ?? 'carry this through the cut',
          },
        ],
      },
      attachments: { attachments: [] },
      references: { counts: { agent: 0, file: 0, task: 0, attention: 0, skill: 0, terminal: 0, browser: 0 } },
      workspace: { cwd: '/work', head: null, status: null, repositorySnapshot: null },
      lineage: { wardenLineage: false, warden: null },
    },
    notCarried: [],
  });
}

interface Harness {
  readonly subject: FileSessionTransferTargetPlanStore;
  readonly folder: MemoryStateFolder;
  readonly state: StatePort;
}

function harness(): Harness {
  const folder = new MemoryStateFolder();
  const state = folder.port([TransferPlanFiles]);
  return { subject: new FileSessionTransferTargetPlanStore(state), folder, state };
}

describe('deriveTransferPlanId', () => {
  it('is deterministic in the (source session, request id) pair and nothing else', () => {
    should(deriveTransferPlanId(SOURCE, REQUEST)).equal(deriveTransferPlanId(SOURCE, REQUEST));
    should(deriveTransferPlanId(SOURCE, REQUEST)).not.equal(deriveTransferPlanId(SOURCE, 'req-2'));
    should(deriveTransferPlanId(SOURCE, REQUEST)).not.equal(deriveTransferPlanId('other-session', REQUEST));
    should(deriveTransferPlanId(SOURCE, REQUEST)).match(/^[0-9a-f]{64}$/);
  });
});

describe('FileSessionTransferTargetPlanStore install (target plan copy)', () => {
  it('installs the plan under the target ferret after create, idempotently', async () => {
    // Arrange
    const { subject, folder } = harness();
    const target = parseSessionId('target-session');
    const frozen = makePlan({});

    // Act
    const first = await subject.install(target, frozen);
    const second = await subject.install(target, frozen);

    // Assert — a replay re-installs the same plan id and the document holds the same plan.
    should(first.status).equal('installed');
    should(second.status).equal('present');
    const { format, ...stored } = JSON.parse(folder.raw(TransferPlanFiles, target) ?? 'null') as { format: number };
    should(format).equal(1);
    const onDisk = SessionTransferPlanSchema.parse(stored);
    should(onDisk.planId).equal(PLAN_ID);
    should(await subject.load(target)).eql(frozen);
  });

  it('declares the plan private and leaves a damaged one to refuse rather than read as absent', () => {
    // Assert — mode 0600; the default damaged policy answers the damage, where a narrower reading would answer
    // "absent" and let a fresh install write over the evidence.
    should(TransferPlanFiles.mode).equal(0o600);
    should(TransferPlanFiles.onDamaged).equal('subsystem');
    should(TransferPlanFiles.path).equal('*/transfer-plan.json');
  });

  it('refuses a different frozen plan even when it reuses the same plan id', async () => {
    const { subject, folder } = harness();
    const target = parseSessionId('target-session');
    await subject.install(target, makePlan({}));
    const before = folder.raw(TransferPlanFiles, target);

    const error = await reject(subject.install(target, makePlan({ preparedAt: '2025-08-08T00:00:00+00:00' })));

    should(error).be.instanceOf(SessionTransferPlanConflictError);
    should((error as SessionTransferPlanConflictError).conflict).equal('session_claimed');
    should(folder.raw(TransferPlanFiles, target)).equal(before);
  });

  it('refuses to install a second plan id into a target one transfer already created', async () => {
    // Arrange
    const { subject, folder } = harness();
    const target = parseSessionId('target-session');
    await subject.install(target, makePlan({}));
    const before = folder.raw(TransferPlanFiles, target);

    // Act + Assert — a different plan id cannot supplant the target's provenance.
    const otherPlanId = deriveTransferPlanId(SOURCE, 'req-2');
    const error = await reject(subject.install(target, makePlan({ planId: otherPlanId })));
    should(error).be.instanceOf(SessionTransferPlanConflictError);
    should((error as SessionTransferPlanConflictError).conflict).equal('session_claimed');
    should(folder.raw(TransferPlanFiles, target)).equal(before);
  });

  it("keeps each target its own: one ferret's plan never answers for another's", async () => {
    // Arrange
    const { subject } = harness();
    const first = parseSessionId('target-one');
    const second = parseSessionId('target-two');

    // Act
    await subject.install(first, makePlan({}));

    // Assert
    should(await subject.load(second)).equal(undefined);
    should((await subject.install(second, makePlan({ planId: deriveTransferPlanId(SOURCE, 'req-2') }))).status).equal(
      'installed',
    );
  });

  it('serialises two installs of one plan, so exactly one installs and the other finds it present', async () => {
    // Arrange
    const { subject } = harness();
    const target = parseSessionId('target-session');

    // Act
    const outcomes = await Promise.all([subject.install(target, makePlan({})), subject.install(target, makePlan({}))]);

    // Assert
    should(outcomes.map(outcome => outcome.status).sort()).eql(['installed', 'present']);
  });

  it('lets only one of two racing different plans claim the target', async () => {
    // Arrange
    const { subject } = harness();
    const target = parseSessionId('target-session');
    const other = makePlan({ planId: deriveTransferPlanId(SOURCE, 'req-2') });

    // Act
    const settled = await Promise.allSettled([subject.install(target, makePlan({})), subject.install(target, other)]);

    // Assert
    should(settled.map(result => result.status).sort()).eql(['fulfilled', 'rejected']);
    const rejected = settled.find(result => result.status === 'rejected') as PromiseRejectedResult;
    should(rejected.reason).be.instanceOf(SessionTransferPlanConflictError);
  });

  it('surfaces a plan the port cannot read rather than reading it as no plan', async () => {
    // Arrange — the port answers an I/O damage for the plan file (the analogue of a path that cannot be opened).
    const { state, folder } = harness();
    const damaged: StatePort = {
      ...state,
      read: async file => ({
        ok: false,
        error: { file: file.path, reason: 'io', sentence: `${file.path} cannot be used: it cannot be read.` },
      }),
      update: async file => ({
        ok: false,
        error: { file: file.path, reason: 'io', sentence: `${file.path} cannot be used: it cannot be read.` },
      }),
    };
    const subject = new FileSessionTransferTargetPlanStore(damaged);
    const target = parseSessionId('target-session');

    // Act
    const installError = await reject(subject.install(target, makePlan({})));
    const loadError = await reject(subject.load(target));

    // Assert — only a missing file means "no plan"; anything else must not be mistaken for it and overwritten.
    should(installError).be.instanceOf(SessionTransferPlanCorruptError);
    should(loadError).be.instanceOf(SessionTransferPlanCorruptError);
    should(folder.raw(TransferPlanFiles, target)).equal(undefined);
  });
});

describe('FileSessionTransferTargetPlanStore durability', () => {
  it('survives a crash right after the plan landed: the replay finds it present', async () => {
    // Arrange — the write lands and then the process "dies" before install can return.
    const { subject, folder } = harness();
    const target = parseSessionId('target-session');
    folder.armCrash();
    const crash = await reject(subject.install(target, makePlan({})));
    should(crash).be.instanceOf(SimulatedCrash);
    folder.revive();

    // Act
    const replay = await subject.install(target, makePlan({}));

    // Assert — the document the first attempt left is the plan, and the replay accepts it as the very same one.
    should(replay.status).equal('present');
    should((await subject.load(target))?.planId).equal(PLAN_ID);
  });

  it('writes an exact replay through the port again, so a visible plan is made durable before it is vouched for', async () => {
    // Arrange — an earlier attempt left the plan visible; the next process cannot know it was flushed.
    const { subject, folder } = harness();
    const target = parseSessionId('target-session');
    await subject.install(target, makePlan({}));
    folder.armCrash();

    // Act — the crash is armed for the NEXT write the port lands: a replay that declined to write would never
    // consume it, and would be vouching for bytes it had not made durable.
    const replay = await reject(subject.install(target, makePlan({})));

    // Assert
    should(replay).be.instanceOf(SimulatedCrash);
    folder.revive();
    should((await subject.load(target))?.planId).equal(PLAN_ID);
  });

  it('writes nothing when it refuses a conflicting plan', async () => {
    // Arrange
    const { subject, folder } = harness();
    const target = parseSessionId('target-session');
    await subject.install(target, makePlan({}));
    folder.armCrash();

    // Act — a refusal must not land a write (and so must not consume the armed crash).
    const error = await reject(subject.install(target, makePlan({ preparedAt: '2025-08-08T00:00:00+00:00' })));

    // Assert
    should(error).be.instanceOf(SessionTransferPlanConflictError);
    should(folder.crashed).equal(false);
  });
});

describe('FileSessionTransferTargetPlanStore capability boundary', () => {
  it('owns only the target plan and exposes no global receipt writer or path', async () => {
    const { subject } = harness();
    const target = parseSessionId('target-session');

    should(Object.getOwnPropertyNames(Object.getPrototypeOf(subject))).not.containEql('record');
    should(Object.getOwnPropertyNames(Object.getPrototypeOf(subject))).not.containEql('receiptPath');
    should(await subject.load(target)).equal(undefined);
    should((await subject.install(target, makePlan({}))).status).equal('installed');
    should((await subject.load(target))?.planId).equal(PLAN_ID);
  });
});

describe('FileSessionTransferTargetPlanStore unreadable and corrupt documents', () => {
  it('refuses a target plan document that is not valid JSON or not a valid plan, rather than reporting it absent', async () => {
    // Arrange
    const { subject, folder } = harness();
    const target = parseSessionId('20260806-target');

    // Act + Assert
    folder.plant(TransferPlanFiles, '{ not json', target);
    await should(subject.load(target)).be.rejectedWith(SessionTransferPlanCorruptError);
    folder.plant(TransferPlanFiles, JSON.stringify({ format: 1, v: 1 }), target);
    await should(subject.load(target)).be.rejectedWith(SessionTransferPlanCorruptError);
    await should(subject.install(target, makePlan({}))).be.rejectedWith(SessionTransferPlanCorruptError);
    // The evidence is never rewritten.
    should(folder.raw(TransferPlanFiles, target)).equal(JSON.stringify({ format: 1, v: 1 }));
  });

  it('refuses a plan of another document format, never reading it as this one', async () => {
    // Arrange
    const { subject, folder } = harness();
    const target = parseSessionId('20260806-target');
    folder.plant(TransferPlanFiles, JSON.stringify({ format: 2, ...makePlan({}) }), target);

    // Act + Assert
    await should(subject.load(target)).be.rejectedWith(SessionTransferPlanCorruptError);
  });
});
