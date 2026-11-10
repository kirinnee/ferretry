import { diskPaths } from '@ferretry/kernel/testing';
import { afterEach, describe, it } from 'bun:test';
import { createHash } from 'node:crypto';
import type { MemoryStateFolder } from '@ferretry/kernel/testing';
import { FerretHistoryFiles, FerretConfigFile, FerretStateFile } from '../../../../contract/index.ts';
import { TransferPlanFiles } from '../../../../contract/transfer-state.ts';
import type { SessionTransferPlan } from '../../../../contract/transfer.ts';
import { SessionConfigSchema, SessionStateSchema, type SessionView } from '../../../../daemon/lib/protocol/session.ts';
import type { JsonValue } from '@ferretry/std';
import should from 'should';
import {
  SessionForkTargetBinder,
  type SessionForkTargetBinderPorts,
  SessionForkTargetBindingError,
  forkOpeningTurn,
} from '../../../../daemon/adapters/forks/session-fork-target-binder.ts';
import {
  SessionForkTargetResolutionError,
  type SessionForkTargetAccount,
} from '../../../../daemon/adapters/forks/session-fork-target-resolver.ts';
import { NodeWorkingDirectoryResolver } from '../../../../daemon/adapters/session/lifecycle/node-working-directory-resolver.ts';
import {
  type SessionProtocolEnvelope,
  StorageSessionLifecycleRepository,
} from '../../../../daemon/adapters/session/lifecycle/storage-session-lifecycle-repository.ts';
import type { DaemonStorage } from '../../../../daemon/adapters/storage/session-storage.ts';
import { FileSessionAttachmentCopier } from '../../../../daemon/adapters/transfer/attachment-copier.ts';
import { FileSessionTransferBriefWriter } from '../../../../daemon/adapters/transfer/brief-writer.ts';
import { FileSessionTransferTargetPlanStore } from '../../../../daemon/adapters/transfer/plan-store.ts';
import { StorageTransferEnvelopeWriter } from '../../../../daemon/adapters/transfer/storage-transfer-envelope-writer.ts';
import { KeyedSerialExecutor } from '../../../../daemon/adapters/storage/keyed-serial-executor.ts';
import type { SessionForkBoundTarget } from '../../../../daemon/lib/forks/types.ts';
import { assignedTaskDocument } from '../../../../daemon/lib/session/lifecycle/policy.ts';
import { sessionTmuxName } from '../../../../daemon/lib/session/lifecycle/policy.ts';
import {
  claudeSessionArguments,
  codexCorrelationArguments,
} from '../../../../daemon/lib/session/peers/transcript-launch.ts';
import { SessionLifecycleService } from '../../../../daemon/lib/session/lifecycle/service.ts';
import { defaultSessionLifecycleSettings } from '../../../../daemon/lib/session/lifecycle/settings.ts';
import {
  MAX_ASSIGNED_TASK_LENGTH,
  SESSION_BOARD_CAPABILITY_VARIABLE,
} from '../../../../daemon/lib/session/lifecycle/types.ts';
import type { SessionLifecycleRecord } from '../../../../daemon/lib/session/lifecycle/types.ts';
import { memoryStorage } from '../../../support/daemon/storage.ts';
import { type SessionId, parseSessionId } from '../../../../daemon/lib/session-id.ts';
import type { TransferConversationValidator } from '../../../../daemon/lib/transfer/types.ts';
import {
  AT,
  SOURCE_ID,
  TARGET_ID,
  account,
  cleanup,
  harnessFacts,
  MemoryAttachmentStore,
  memoryEffectLedger,
  runtimeEffectFingerprint,
  openStorage,
  plan,
  planner,
  realTemporaryDirectory,
} from './fixtures.ts';

/**
 * The fork write surface, against real session documents, a real lifecycle and the real transfer
 * importer.
 *
 * Everything asserted here is a property a replay depends on, so nothing is stubbed that could hide
 * one: the record is the lifecycle's own, the plan copy is the durable one, the brief is the file the
 * agent will actually read, and the runtime control is observed relative to the turn-one delivery
 * rather than merely counted.
 */

const TARGET_CAPABILITY = 'target-capability';
const CAPABILITY_HASH = createHash('sha256').update(TARGET_CAPABILITY).digest('hex');
const TARGET_HARNESS_HOME = '/fleet/homes/zelda';
const TARGET_HARNESS_SESSION = 'harness-target';
const LAUNCH_ARGUMENTS = claudeSessionArguments(TARGET_HARNESS_SESSION);

interface Harness {
  readonly ports: SessionForkTargetBinderPorts;
  /** The session store as it is NOW: a restart replaces it, over the same state. */
  readonly storage: DaemonStorage;
  readonly plan: SessionTransferPlan;
  readonly target: SessionId;
  readonly sessionDirectory: (id: string) => string;
  /** Everything the launcher and the runtime path did, in the order it happened. */
  readonly happened: string[];
  readonly plans: FileSessionTransferTargetPlanStore;
  /** The kernel test host's state, where the journal, the plan and the brief of every session live. */
  readonly folder: MemoryStateFolder;
  /** The attachment owner's store, which a fork reads the source from and copies the target into. */
  readonly attachments: MemoryAttachmentStore;
  /** The opening-turn document as it is held, or undefined when none is. */
  brief(): string | undefined;
  /** Replaces the opening-turn document, as somebody rewriting it would. */
  plantBrief(text: string): void;
  /**
   * A daemon restart: a fresh session store over the very same state files. `forgetIndex` also loses the event index,
   * which is what a crash BEFORE the index caught up with a write leaves — the index is a cache of the journals.
   */
  restart(options?: { readonly forgetIndex?: boolean }): Promise<void>;
  bind(): SessionForkBoundTarget;
  counts(): { readonly captures: number; readonly creates: number };
  /** Makes the published fleet answer differently between two attempts at one fork. */
  publish(next: SessionForkTargetAccount): void;
}

async function harness(
  label: string,
  overrides: {
    readonly plan?: (base: SessionTransferPlan) => SessionTransferPlan;
    readonly validator?: TransferConversationValidator;
    /** Makes the one resolver's `validate` half refuse, as an unserviceable effort would. */
    readonly refuseRuntime?: boolean;
    /** Fails the lifecycle's first task persistence, after startup runtime work but before turn one. */
    readonly failTaskWriteOnce?: boolean;
    /** Loses one startup runtime outcome after the effect began and the harness was driven. */
    readonly loseRuntimeOutcomeOnce?: boolean;
  } = {},
): Promise<Harness> {
  const opened = await openStorage(label);
  let storage = opened.storage;
  const cwd = await realTemporaryDirectory(`fy-fork-${label}-cwd-`);
  const base = plan(cwd);
  const frozen = overrides.plan === undefined ? base : overrides.plan(base);
  const target = parseSessionId(TARGET_ID);
  const happened: string[] = [];
  const counters = { captures: 0, creates: 0 };
  const effects = memoryEffectLedger();
  let terminalAlive = false;
  let failTaskWrite = overrides.failTaskWriteOnce === true;
  let loseRuntimeOutcome = overrides.loseRuntimeOutcomeOnce === true;
  let resolved: SessionForkTargetAccount = { account: account(), executable: '/fleet/bin/claude-auto-zelda' };
  let environment: Readonly<Record<string, string>> = {};

  const plans = new FileSessionTransferTargetPlanStore(opened.state);
  const briefWriter = new FileSessionTransferBriefWriter(opened.briefs);
  const attachments = new MemoryAttachmentStore();
  const attachmentCopier = new FileSessionAttachmentCopier(attachments);

  const ports: SessionForkTargetBinderPorts = {
    get storage() {
      return storage;
    },
    createLifecycle: (id: SessionId, envelope?: SessionProtocolEnvelope) =>
      new SessionLifecycleService(
        {
          repository: new StorageSessionLifecycleRepository(storage, envelope),
          launcher: {
            alive: async () => terminalAlive,
            launch: async () => {
              terminalAlive = true;
              happened.push('launch');
            },
            ready: async _record => {
              happened.push('ready');
            },
            deliver: async (_record, instruction, beforeWrite) => {
              await beforeWrite?.();
              happened.push(`deliver:${instruction.includes('turn-001.md') ? 'turn-one' : 'other'}`);
            },
            snapshot: async () => undefined,
            stop: async () => {
              terminalAlive = false;
            },
          },
          tasks: {
            writeAssignedTask: async (held, document) => {
              if (failTaskWrite) {
                failTaskWrite = false;
                happened.push('task:write-failed');
                throw new Error('the one-shot task persistence failed');
              }
              // The lifecycle's turn-one document IS the brief file: both are the one `turns/turn-001.md` the new
              // agent is pointed at, so whichever writes last, the bytes it reads are identical.
              return await briefWriter.write(held, document);
            },
          },
          effects,
          directories: new NodeWorkingDirectoryResolver(diskPaths()),
          ids: {
            next: () => {
              counters.creates += 1;
              return id;
            },
          },
          clock: { now: () => AT },
          serial: new KeyedSerialExecutor(),
          credentials: { issue: () => ({ capability: TARGET_CAPABILITY, hash: CAPABILITY_HASH }) },
          environment: {
            write: async (_id, variables) => {
              environment = { ...variables };
            },
            read: async () => environment,
          },
        },
        defaultSessionLifecycleSettings,
      ),
    accounts: async agent => await Promise.resolve(resolveAgent(agent)),
    runtimeChoice: {
      validate: async (target, cwd) => {
        happened.push(`validate:${target.harness}:${target.effort}:${cwd}`);
        if (overrides.refuseRuntime === true)
          throw new SessionForkTargetResolutionError('agent_unavailable', 'that reasoning level is not advertised');
      },
    },
    planner: planner(),
    plans: {
      read: async id => await plans.load(id),
      install: async (id, value) => await plans.install(id, value),
    },
    transcripts: {
      // The real capture's Claude arm: mint an id, name the file it decides from the home, the
      // working directory and that id, and put the argv on the launch that makes it true.
      capture: async request => {
        counters.captures += 1;
        return {
          provenance: {
            v: 1,
            home: TARGET_HARNESS_HOME,
            harnessSessionId: TARGET_HARNESS_SESSION,
            identity: 'minted',
            file: harnessFacts.claudeTranscriptFile(TARGET_HARNESS_HOME, request.cwd, TARGET_HARNESS_SESSION),
            resolvedAt: AT,
          },
          launchArguments: [...claudeSessionArguments(TARGET_HARNESS_SESSION)],
        };
      },
    },
    importPorts: {
      get envelope() {
        return new StorageTransferEnvelopeWriter(storage);
      },
      brief: briefWriter,
      attachments: attachmentCopier,
      conversation: overrides.validator ?? frozenValidator(frozen),
    },
    imported: { brief: briefWriter, attachments: attachmentCopier },
    environment: { read: async () => environment },
    tmuxSession: id => sessionTmuxName(id, defaultSessionLifecycleSettings),
    /**
     * The STARTUP half only, matching the narrow port the binder now depends on.
     *
     * The public `control` is deliberately absent rather than stubbed: a fork reaches the runtime
     * through the entry point that admits a `starting` session, and a harness that still offered the
     * mounted surface would let this file keep passing if the binder were ever pointed back at it.
     * The effect logic below is unchanged — same key namespace, same opaque fingerprint tuple, same
     * begun/settled/conflict handling, same lost-outcome injection.
     */
    runtime: {
      startupWhileHeld: async (sessionId, request, requestId) => {
        const id = parseSessionId(sessionId);
        const key = { sessionId: id, effectId: `runtime:${requestId}` } as const;
        const fingerprint = runtimeEffectFingerprint(request);
        const standing = await effects.inspect(key, fingerprint);
        // A settled startup is a boundary already crossed, so the replay drives nothing at all.
        if (standing === 'settled') return;
        if (standing !== 'unclaimed')
          throw new Error(`runtime effect ${requestId} is ${standing}, so it cannot be driven again`);
        const admission = await effects.begin(key, fingerprint, AT);
        if (admission !== 'perform')
          throw new Error(`runtime effect ${requestId} was admitted as ${admission}, so it cannot be driven`);
        happened.push(`runtime:${sessionId}:${JSON.stringify(request)}:${requestId}`);
        if (loseRuntimeOutcome) {
          loseRuntimeOutcome = false;
          throw new Error(`runtime effect ${requestId} reached the harness but its outcome bookkeeping was lost`);
        }
        await effects.settle(key, fingerprint, AT);
      },
    },
    view: async id => await view(storage, opened.sessionDirectory, id).catch(() => undefined),
    sessionDirectory: id => opened.sessionDirectory(id),
    harnessFacts,
    readableHandoffs: id => [`${opened.sessionDirectory(id)}/turns`],
    clock: { now: () => AT },
  };

  function resolveAgent(agent: string): SessionForkTargetAccount {
    if (agent !== resolved.account.agent && agent !== resolved.account.id)
      throw Object.assign(new Error(`no account is published as ${JSON.stringify(agent)}`), {
        failure: 'unknown_agent',
      });
    return resolved;
  }

  return {
    ports,
    get storage() {
      return storage;
    },
    plan: frozen,
    target,
    sessionDirectory: opened.sessionDirectory,
    happened,
    plans,
    folder: opened.folder,
    attachments,
    brief: () => opened.briefText(TARGET_ID),
    plantBrief: next => opened.plantBrief(TARGET_ID, next),
    restart: async options => {
      if (options?.forgetIndex === true)
        for (const database of opened.folder.databases.keys()) opened.folder.databases.delete(database);
      storage = (await memoryStorage({ folder: opened.folder, clock: { now: () => AT } })).storage;
    },
    bind: () => new SessionForkTargetBinder(ports).bind(TARGET_ID, frozen),
    counts: () => ({ captures: counters.captures, creates: counters.creates }),
    publish: (next: SessionForkTargetAccount) => {
      resolved = next;
    },
  };
}

/** The import preflight, answering exactly the prefix the frozen plan carries. */
function frozenValidator(frozen: SessionTransferPlan): TransferConversationValidator {
  return {
    digestPinned: async input => ({
      sessionId: input.sourceSessionId,
      through: input.through,
      messages: [...(frozen.facets.conversation?.messages ?? [])],
      omissions: [],
    }),
  };
}

async function view(
  storage: DaemonStorage,
  sessionDirectory: (id: string) => string,
  id: SessionId,
): Promise<SessionView> {
  const config = SessionConfigSchema.parse(await storage.readConfig(id));
  const state = SessionStateSchema.parse(await storage.readState(id));
  return { config, state, directory: sessionDirectory(id) };
}

/**
 * Damages a held session document the way a hand edit or a bad disk would: planted straight into the state, because the
 * session store itself refuses to WRITE a document its declared schema rejects.
 */
function damage(
  subject: Harness,
  file: typeof FerretConfigFile | typeof FerretStateFile,
  change: (document: Record<string, unknown>) => Record<string, unknown>,
): void {
  const held = JSON.parse(subject.folder.raw(file, TARGET_ID) ?? '{}') as Record<string, unknown>;
  subject.folder.plant(file, JSON.stringify(change(held)), TARGET_ID);
}

async function refusal(promise: Promise<unknown>): Promise<SessionForkTargetBindingError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SessionForkTargetBindingError) return error;
    throw error;
  }
  throw new Error('expected the fork target to be refused, but it resolved');
}

/** Drives the whole bound surface in the order the fork service drives it. */
async function drive(subject: Harness): Promise<SessionView> {
  const bound = subject.bind();
  await bound.lifecycle.create(subject.plan);
  await bound.plans.persist(subject.plan);
  await bound.importer.importPlan(subject.plan, TARGET_ID);
  await bound.lifecycle.captureTranscriptProvenance();
  return await bound.lifecycle.start();
}

async function record(subject: Harness): Promise<SessionLifecycleRecord> {
  const found = await new StorageSessionLifecycleRepository(subject.storage).read(subject.target);
  if (found === undefined) throw new Error('the target record is missing');
  return found;
}

/**
 * The durable narrative of one target, in order.
 *
 * Read through the same storage the binder writes through, because the fact under proof is what a
 * later reader of this session will actually find.
 */
async function journal(subject: Harness): Promise<readonly { type: string; data: unknown }[]> {
  const page = await subject.storage.replay(subject.target, 0, 100);
  return page.events.map(event => ({ type: event.type, data: event.data }));
}

/**
 * A target created exactly as a fork creates it, and then reduced to the one incomplete prefix a
 * crash can leave: config and state published, journal reserved and empty.
 *
 * Lifecycle creation publishes the configuration, then the state, then appends `session.created`.
 * A process that dies between the state write and the append leaves precisely this — a record that
 * reads back perfectly well as `created` with nothing in its journal. Truncating the reserved
 * journal in place reproduces it without hand-forging a record, so what is under test is the real
 * document shape rather than a fixture's idea of one.
 */
async function targetWithEmptyJournal(subject: Harness): Promise<void> {
  await subject.bind().lifecycle.create(subject.plan);
  subject.folder.plant(FerretHistoryFiles, '', TARGET_ID);
  // A crash leaves a daemon that starts over: its index has never heard of a journal for this target.
  await subject.restart({ forgetIndex: true });
}

describe('SessionForkTargetBinder', () => {
  afterEach(async () => await cleanup());

  it('should create a fresh target, import into it, capture its own transcript and start it', async () => {
    // Arrange
    const subject = await harness('journey');

    // Act
    const started = await drive(subject);

    // Assert: a fresh identity that inherits nothing it must not.
    const held = await record(subject);
    should(held.config.id).equal(TARGET_ID);
    should(held.config.cwd).equal(subject.plan.durable.cwd);
    should(held.config.mode).equal('auto');
    should(held.config.parent).equal(undefined);
    should(held.config.capabilityHash).equal(CAPABILITY_HASH);
    should(started.config.incarnation).equal(`${TARGET_ID}-1`);
    should(started.config.runtimeGeneration).equal(1);
    should(started.config.teammate).equal(undefined);
    should(started.config.harness).equal('claude');
    should(started.config.agent).equal('claude-auto-zelda');
    should(started.config.model).equal('claude-opus-5');
    should(started.config.turn).equal(1);
    // The lineage edge, on the TARGET, naming the exact cut.
    should(started.config.transferredFrom?.kind).equal('fork');
    should(started.config.transferredFrom?.sourceSessionId).equal(SOURCE_ID);
    should(started.config.transferredFrom?.cutMessagePoint).eql({ v: 1, byteOffset: 512, blockIndex: 0 });
    should(started.config.transferredFrom?.planId).equal(subject.plan.planId);
    // The target's OWN transcript, with the argv that makes it true appended to the base command.
    should(started.config.transcript?.harnessSessionId).equal('harness-target');
    should(held.config.command).eql([
      '/fleet/bin/claude-auto-zelda',
      '--chrome',
      '--rc',
      '--remote-control-session-name-prefix',
      `fyrc-${TARGET_ID}`,
      // Its own turn documents, readable without a permission prompt, ahead of the operator's flags.
      `--allowedTools=Read(/${subject.sessionDirectory(TARGET_ID)}/turns/**)`,
      '--dangerously-skip-permissions',
      ...harnessFacts.startupModelArguments('claude-opus-5'),
      ...LAUNCH_ARGUMENTS,
    ]);
    // The plan is durable beneath the target, so a later replay reads it rather than the source.
    should((await subject.plans.load(subject.target))?.planId).equal(subject.plan.planId);
    should(subject.counts()).eql({ captures: 1, creates: 1 });
  });

  it('should reallocate the title and never carry the source callsign', async () => {
    // Arrange
    const subject = await harness('fresh-identity');

    // Act
    const started = await drive(subject);

    // Assert: §12.3 rules both non-durable. A carried callsign would make one bare name resolve to
    // two sessions, and a carried title would label a new conversation with the old one's work.
    should(started.config.teammate).equal(undefined);
    should(started.config.name).not.equal(subject.plan.source.name);
    should(JSON.stringify(started.config)).not.match(/alistair/u);
  });

  it('should refuse before the target exists when the account cannot serve the runtime choice', async () => {
    // Arrange
    const subject = await harness('runtime-refused', { refuseRuntime: true });

    // Act
    let refused: unknown;
    try {
      await subject.bind().lifecycle.create(subject.plan);
    } catch (error) {
      refused = error;
    }

    // Assert: the resolver's own refusal, and no session created to carry a conversation it could
    // never be given the reasoning level it was forked for.
    should(refused).be.instanceof(SessionForkTargetResolutionError);
    should(subject.counts().creates).equal(0);
    should(await subject.storage.readConfig(subject.target).catch(() => undefined)).equal(undefined);
  });

  it('should refuse a plan whose rendered opening turn the lifecycle would reject', async () => {
    // Arrange: a conversation too large to be handed over as a first turn.
    const subject = await harness('oversized-brief', {
      plan: base => ({
        ...base,
        facets: {
          ...base.facets,
          conversation: {
            messages: [
              {
                point: { v: 1, byteOffset: 512, blockIndex: 0 },
                role: 'assistant' as const,
                text: 'x'.repeat(MAX_ASSIGNED_TASK_LENGTH + 1),
              },
            ],
          },
        },
      }),
    });

    // Act
    const refused = await refusal(subject.bind().lifecycle.create(subject.plan));

    // Assert: refused with the lifecycle's own limit rather than a raw schema error from inside it.
    should(refused.message).match(/renders an opening turn of \d+ characters/u);
    should(refused.message).match(new RegExp(String(MAX_ASSIGNED_TASK_LENGTH), 'u'));
    should(subject.counts().creates).equal(0);
  });

  it('should refuse to create against a model the account has stopped serving', async () => {
    // Arrange: the manifest is republished with a different default while the plan is frozen.
    const subject = await harness('model-drift');
    subject.publish({
      account: account({ defaultModel: 'claude-sonnet-5', models: [{ id: 'claude-sonnet-5', available: true }] }),
      executable: '/fleet/bin/claude-auto-zelda',
    });

    // Act
    const refused = await refusal(subject.bind().lifecycle.create(subject.plan));

    // Assert: never silently launch a session at a model the caller was not shown — and say WHY rather
    // than merely that two identifiers differ. "Expected opus, got sonnet" is true and starts an
    // investigation; the account's own answer to "can you serve opus" ends one.
    should(refused.message).match(/was prepared for a model this account cannot serve/u);
    should(refused.message).match(/does not serve model "claude-opus-5"/u);
    should(refused.message).match(/It serves claude-sonnet-5/u);
    should(subject.counts().creates).equal(0);
  });

  it('should refuse a write surface driven with a decision other than the one it was bound to', async () => {
    // Arrange
    const subject = await harness('foreign-plan');
    const other = { ...subject.plan, preparedAt: '2026-08-06T10:00:00.000Z' };

    // Act
    const refused = await refusal(subject.bind().lifecycle.create(other));

    // Assert
    should(refused.message).match(/was driven with a different decision/u);
  });

  it('should apply the fork runtime choice after launch and before turn one is delivered', async () => {
    // Arrange
    const subject = await harness('runtime-order');

    // Act
    await drive(subject);

    // Assert: the deterministic plan-derived request id, and the ordering the whole feature rests on.
    should(subject.happened.filter(step => !step.startsWith('validate:'))).eql([
      'launch',
      'ready',
      `runtime:${TARGET_ID}:{"action":"effort","effort":"high"}:${subject.plan.planId}:startup-runtime`,
      'deliver:turn-one',
    ]);
    // And the account was proved able to serve that level in the directory the plan froze, before
    // the target record existed at all.
    should(subject.happened[0]).equal(`validate:claude:high:${subject.plan.durable.cwd}`);
  });

  it('should resume after settled startup runtime without driving it or the opening turn twice', async () => {
    // Arrange: the runtime act settles, then the task writer fails before the first-turn ledger can
    // admit any pane write. That is the recoverable half of the two adjacent crash windows.
    const subject = await harness('runtime-settled-replay', { failTaskWriteOnce: true });
    const bound = subject.bind();
    await bound.lifecycle.create(subject.plan);
    await bound.plans.persist(subject.plan);
    await bound.importer.importPlan(subject.plan, TARGET_ID);
    await bound.lifecycle.captureTranscriptProvenance();

    // Act: lose the first start response at task persistence, then replay through a newly bound
    // lifecycle exactly as a fork retry would re-enter this boundary.
    let firstFailure: unknown;
    try {
      await bound.lifecycle.start();
    } catch (error) {
      firstFailure = error;
    }
    const replay = await subject.bind().lifecycle.start();

    // Assert: the plan-derived id/fingerprint answers the second runtime call from its settled fact;
    // only the still-unclaimed opening turn is performed, and the already-live pane is not relaunched.
    should(firstFailure).be.instanceOf(Error);
    should((firstFailure as Error).message).match(/one-shot task persistence failed/u);
    should(replay.state.status).equal('running');
    should(subject.happened.filter(step => !step.startsWith('validate:'))).eql([
      'launch',
      'ready',
      `runtime:${TARGET_ID}:{"action":"effort","effort":"high"}:${subject.plan.planId}:startup-runtime`,
      'task:write-failed',
      'ready',
      'deliver:turn-one',
    ]);
    should(subject.happened.filter(step => step.startsWith('runtime:'))).have.length(1);
    should(subject.happened.filter(step => step === 'deliver:turn-one')).have.length(1);
  });

  it('should refuse replay after startup runtime began without driving it or delivering turn one again', async () => {
    // Arrange: the first attempt durably admits the runtime act and reaches the harness, then loses
    // its outcome before settlement. The lifecycle owns no receipt phase, so the service-journey
    // tier separately proves that the fork receipt remains at `provenance_captured`.
    const subject = await harness('runtime-unsettled-replay', { loseRuntimeOutcomeOnce: true });
    const bound = subject.bind();
    await bound.lifecycle.create(subject.plan);
    await bound.plans.persist(subject.plan);
    await bound.importer.importPlan(subject.plan, TARGET_ID);
    await bound.lifecycle.captureTranscriptProvenance();

    // Act: retry through a newly bound lifecycle, exactly as the service re-enters the target after
    // a lost response. The shared ledger must refuse rather than re-drive the already-begun act.
    let firstFailure: unknown;
    let replayFailure: unknown;
    try {
      await bound.lifecycle.start();
    } catch (error) {
      firstFailure = error;
    }
    try {
      await subject.bind().lifecycle.start();
    } catch (error) {
      replayFailure = error;
    }

    // Assert: readiness may be re-proved, but the picker/runtime act is driven once, turn one is
    // never delivered, and the target does not cross the lifecycle's running boundary.
    should(firstFailure).be.instanceOf(Error);
    should((firstFailure as Error).message).match(/outcome bookkeeping was lost/u);
    should(replayFailure).be.instanceOf(Error);
    should((replayFailure as Error).message).match(/is unsettled, so it cannot be driven again/u);
    should((await record(subject)).state.status).equal('failed');
    should(subject.happened.filter(step => !step.startsWith('validate:'))).eql([
      'launch',
      'ready',
      `runtime:${TARGET_ID}:{"action":"effort","effort":"high"}:${subject.plan.planId}:startup-runtime`,
      'ready',
    ]);
    should(subject.happened.filter(step => step.startsWith('runtime:'))).have.length(1);
    should(subject.happened.filter(step => step === 'deliver:turn-one')).have.length(0);
  });

  it('should ask for no runtime control when the fork chose no effort', async () => {
    // Arrange
    const subject = await harness('runtime-none', {
      plan: base => ({ ...base, target: { ...base.target, effort: null } }),
    });

    // Act
    await drive(subject);

    // Assert
    // With no pre-turn runtime work, lifecycle does not make a redundant explicit readiness call;
    // the production delivery adapter owns its own prompt wait immediately before the turn write.
    should(subject.happened.filter(step => !step.startsWith('validate:'))).eql(['launch', 'deliver:turn-one']);
  });

  it('should write one set of opening-turn bytes for both the importer and the lifecycle', async () => {
    // Arrange
    const subject = await harness('brief-bytes');
    const file = subject.ports.imported.brief.file(TARGET_ID);

    // Act
    const bound = subject.bind();
    await bound.lifecycle.create(subject.plan);
    await bound.plans.persist(subject.plan);
    const outcome = await bound.importer.importPlan(subject.plan, TARGET_ID);
    const imported = subject.brief();
    await bound.lifecycle.captureTranscriptProvenance();
    await bound.lifecycle.start();

    // Assert: the two writers of one document cannot tear each other, and a replay of either
    // converges on the same bytes rather than oscillating between two spellings of one brief.
    should(outcome.briefPath).equal(file);
    should(imported).equal(assignedTaskDocument(forkOpeningTurn(subject.plan)));
    should(subject.brief()).equal(imported);
    should(imported).match(/Prior context carried into this session by a fork/u);
    should(imported).match(/conversation time was rewound but filesystem state was not/u);
  });

  it('should replay onto the target it created rather than creating a second one', async () => {
    // Arrange
    const subject = await harness('replay');
    await drive(subject);
    const before = JSON.stringify(await subject.storage.readConfig(subject.target));

    // Act: a completed receipt reads the target rather than re-running create against running state.
    const bound = subject.bind();
    const observed = await bound.lifecycle.view();

    // Assert: one create, one recorded capture, and a document nothing moved.
    should(subject.counts().creates).equal(1);
    should(JSON.stringify(await subject.storage.readConfig(subject.target))).equal(before);
    should(observed.config.id).equal(TARGET_ID);
    should(observed.config.transcript?.harnessSessionId).equal('harness-target');
  });

  it('should report a completed fork whose pane has moved on to a turn-level status', async () => {
    // Arrange: the turn watcher rewrites the status the moment the target's turn changes.
    const subject = await harness('turn-level');
    await drive(subject);
    await subject.storage.updateState(
      subject.target,
      current => ({ ...(current as Record<string, unknown>), status: 'awaiting_user' }) as JsonValue,
    );

    // Act
    const observed = await subject.bind().lifecycle.view();

    // Assert
    should(observed.config.id).equal(TARGET_ID);
    should(observed.state.status).equal('awaiting_user');
  });

  it('should durably repair a single canonical creation event on an adopted target', async () => {
    // Arrange: the crash prefix — a record that reads as `created` whose journal is empty.
    const subject = await harness('repair-created');
    await targetWithEmptyJournal(subject);
    should(await journal(subject)).eql([]);

    // Act: the replay adopts that record instead of creating again, so nothing else would ever
    // append the event it is missing.
    await subject.bind().lifecycle.create(subject.plan);

    // Assert: exactly one, and it is the canonical boundary derived from the proved record — the
    // authorized wrapper, the mode and the canonical working directory lifecycle creation records.
    const held = await record(subject);
    should(await journal(subject)).eql([
      { type: 'session.created', data: { agent: held.config.agent, mode: held.config.mode, cwd: held.config.cwd } },
    ]);
    // And the receipt may only stamp `target_created` after this returns, so the boundary is durable
    // before the fork is allowed to record that the target exists.
    should(subject.counts().creates).equal(1);
  });

  it('should not duplicate the repaired creation event on a further replay', async () => {
    // Arrange
    const subject = await harness('repair-idempotent');
    await targetWithEmptyJournal(subject);
    await subject.bind().lifecycle.create(subject.plan);

    // Act: two more replays of the same boundary, as a restart loop would produce.
    await subject.bind().lifecycle.create(subject.plan);
    await subject.bind().lifecycle.create(subject.plan);

    // Assert: the second pass sees the event the first one wrote — one event, right type, exact
    // payload — so it recognises the boundary as already complete and owes nothing.
    const held = await record(subject);
    should(await journal(subject)).eql([
      { type: 'session.created', data: { agent: held.config.agent, mode: held.config.mode, cwd: held.config.cwd } },
    ]);
  });

  it('should leave a repaired target with an ordered narrative once it transitions', async () => {
    // Arrange: the whole point of repairing before `target_created` is that everything appended
    // afterwards follows a boundary that is actually there.
    const subject = await harness('repair-ordering');
    await targetWithEmptyJournal(subject);
    const bound = subject.bind();
    await bound.lifecycle.create(subject.plan);
    await bound.plans.persist(subject.plan);
    await bound.importer.importPlan(subject.plan, TARGET_ID);
    await bound.lifecycle.captureTranscriptProvenance();

    // Act
    await bound.lifecycle.start();

    // Assert: creation first, then the transitions — never a journal that opens mid-life.
    const types = (await journal(subject)).map(event => event.type);
    should(types.at(0)).equal('session.created');
    should(types.at(1)).equal('session.starting');
    should(types).containEql('session.running');
  });

  it('should refuse a journal whose first event is not the creation boundary, and append nothing', async () => {
    // Arrange: an emptied journal that then received a real transition. A creation boundary is only
    // ever the FIRST event, so appending one here would manufacture a narrative that never happened.
    const subject = await harness('repair-refusal');
    await targetWithEmptyJournal(subject);
    await subject.storage.append(subject.target, 'session.starting', {});
    const before = await journal(subject);

    // Act
    const refused = await refusal(subject.bind().lifecycle.create(subject.plan));

    // Assert: refused by name, and the journal is exactly as it was.
    should(refused.message).match(/is not one this fork could repair/u);
    should(refused.message).match(/begins with "session.starting"/u);
    should(refused.message).match(/only ever the FIRST event/u);
    should(await journal(subject)).eql(before);
  });

  it('should refuse a creation event whose payload describes some other session', async () => {
    // Arrange: the right TYPE in the right position, and a payload this record cannot imply. A type
    // check alone would call this repaired and leave a narrative nobody can reconstruct.
    const subject = await harness('repair-forged-payload');
    await targetWithEmptyJournal(subject);
    const held = await record(subject);
    await subject.storage.append(subject.target, 'session.created', {
      agent: held.config.agent,
      mode: held.config.mode,
      cwd: '/somewhere/else',
    });
    const before = await journal(subject);

    // Act
    const refused = await refusal(subject.bind().lifecycle.create(subject.plan));

    // Assert
    should(refused.message).match(/its creation event describes/u);
    should(refused.message).match(/somewhere\/else/u);
    should(await journal(subject)).eql(before);
  });

  it('should refuse a lone creation event whose sequence skips the first lifecycle boundary', async () => {
    // Arrange: the journal scanner admits any strictly increasing positive opening sequence, but a
    // lifecycle creation has exactly one possible first event: sequence 1. Accepting sequence 2 here
    // would let the binder call this target repaired even though the fleet tail later rejects the
    // gap between its event count and last sequence.
    const subject = await harness('repair-forged-sequence');
    await targetWithEmptyJournal(subject);
    const held = await record(subject);
    const forged = {
      schemaVersion: 1,
      sequence: 2,
      sessionId: TARGET_ID,
      time: AT,
      type: 'session.created',
      data: { agent: held.config.agent, mode: held.config.mode, cwd: held.config.cwd },
    };
    subject.folder.plant(FerretHistoryFiles, `${JSON.stringify({ format: 1, ...forged })}\n`, TARGET_ID);
    await subject.restart({ forgetIndex: true });
    const before = subject.folder.raw(FerretHistoryFiles, TARGET_ID);

    // Act
    const refused = await refusal(subject.bind().lifecycle.create(subject.plan));

    // Assert: refusal is about the missing first boundary, and the forged journal is untouched.
    should(refused.message).match(/creation boundary has sequence 2/u);
    should(refused.message).match(/first lifecycle event must have sequence 1/u);
    should(subject.folder.raw(FerretHistoryFiles, TARGET_ID)).equal(before);
  });

  it('should refuse a journal that has moved past creation while its state still says created', async () => {
    // Arrange: the exact boundary first, and then a transition — so the FIRST event is correct and
    // the journal is still not the prefix this repairs. The state document lags behind the journal.
    const subject = await harness('repair-extra-event');
    await targetWithEmptyJournal(subject);
    const held = await record(subject);
    await subject.storage.append(subject.target, 'session.created', {
      agent: held.config.agent,
      mode: held.config.mode,
      cwd: held.config.cwd,
    });
    await subject.storage.append(subject.target, 'session.starting', {});
    const before = await journal(subject);

    // Act
    const refused = await refusal(subject.bind().lifecycle.create(subject.plan));

    // Assert: refused on the SHAPE rather than on the first type, which is correct here.
    should(refused.message).match(/carries more than the creation boundary/u);
    should(await journal(subject)).eql(before);
  });

  it('should refuse a target that is not the fresh session the plan reserved', async () => {
    // Arrange: a record that exists under the reserved id and is somebody else's session.
    const subject = await harness('impostor');
    const elsewhere = await realTemporaryDirectory('fy-fork-impostor-elsewhere-');
    await new SessionLifecycleService(
      {
        repository: new StorageSessionLifecycleRepository(subject.storage, {
          incarnation: `${TARGET_ID}-4`,
          runtimeGeneration: 4,
          agent: 'claude-auto-zelda',
          harness: 'claude',
          modelHint: '',
          remoteControl: false,
          harnessFlags: [],
          turn: 9,
          intervalSeconds: 1,
          timeoutSeconds: 1,
          nudgeAfterSeconds: 1,
          killAfterSeconds: 1,
          directSendMaxChars: 1,
          resumeMenuChoice: 'summary',
          maxSnapshots: 1,
          retry: { transientAttempts: 0, stalledAttempts: 0, waitForQuotaReset: false, allowAccountFailover: false },
        }),
        launcher: {
          alive: async () => false,
          launch: async () => undefined,
          ready: async _record => undefined,
          deliver: async (_record, _instruction, beforeWrite) => {
            await beforeWrite?.();
          },
          snapshot: async () => undefined,
          stop: async () => undefined,
        },
        tasks: { writeAssignedTask: async held => subject.ports.imported.brief.file(held) },
        effects: memoryEffectLedger(),
        directories: new NodeWorkingDirectoryResolver(diskPaths()),
        ids: { next: () => subject.target },
        clock: { now: () => AT },
        serial: new KeyedSerialExecutor(),
      },
      defaultSessionLifecycleSettings,
    ).create({
      name: 'Somebody Else',
      agent: '/fleet/bin/claude-auto-zelda',
      command: ['/fleet/bin/claude-auto-zelda'],
      cwd: elsewhere,
      mode: 'interactive',
    });

    // Act
    const refused = await refusal(subject.bind().lifecycle.create(subject.plan));

    // Assert: every disagreement named at once, and nothing overwritten.
    should(refused.message).match(/is not the fresh target plan/u);
    should(refused.message).match(/canonical working directory/u);
    should(refused.message).match(/interaction mode/u);
    should(refused.message).match(/model/u);
    should(refused.message).match(/incarnation/u);
    should(refused.message).match(/runtime generation/u);
    should(refused.message).match(/is not exactly the authorized base command/u);
    should(refused.message).match(/holds no credential of its own/u);
    should((await record(subject)).config.name).equal('Somebody Else');
  });

  it('should refuse a target that already descends from another session', async () => {
    // Arrange
    const subject = await harness('inherited-parent');
    await subject.bind().lifecycle.create(subject.plan);
    await subject.storage.updateConfig(
      subject.target,
      current =>
        ({
          ...(current as Record<string, unknown>),
          parent: SOURCE_ID,
        }) as JsonValue,
    );

    // Act
    const refused = await refusal(subject.bind().lifecycle.create(subject.plan));

    // Assert
    should(refused.message).match(/it descends from "20260806-source" rather than from nothing/u);
  });

  it('should refuse a target whose configuration document no longer satisfies the protocol', async () => {
    // Arrange
    const subject = await harness('corrupt-config');
    await subject.bind().lifecycle.create(subject.plan);
    damage(subject, FerretConfigFile, ({ retry: _retry, ...document }) => document);

    // Act
    const refused = await refusal(subject.bind().lifecycle.create(subject.plan));

    // Assert — the state port holds every session document to its declared schema on every read, so a document the
    // protocol rejects is refused where the record is read, before it can be reconciled against the plan.
    should(refused.message).match(/cannot be read, so this fork cannot prove it is the target it reserved/u);
  });

  it('should refuse a target already holding a different transfer plan', async () => {
    // Arrange
    const subject = await harness('claimed');
    await subject.bind().lifecycle.create(subject.plan);
    await subject.plans.install(subject.target, { ...subject.plan, planId: 'plan-somebody-else' });

    // Act
    const refused = await refusal(subject.bind().lifecycle.create(subject.plan));

    // Assert: one transfer creates one session.
    should(refused.message).match(/already holds transfer plan plan-somebody-else/u);
  });

  it('should refuse when the persisted plan document cannot be read', async () => {
    // Arrange
    const subject = await harness('corrupt-plan');
    await subject.bind().lifecycle.create(subject.plan);
    subject.folder.plant(TransferPlanFiles, '{ not json', TARGET_ID);

    // Act
    const refused = await refusal(subject.bind().lifecycle.create(subject.plan));

    // Assert
    should(refused.message).match(/cannot be read/u);
  });

  it('should refuse to capture or start before a plan has been persisted beneath the target', async () => {
    // Arrange
    const subject = await harness('no-plan');
    await subject.bind().lifecycle.create(subject.plan);

    // Act
    const refused = await refusal(subject.bind().lifecycle.captureTranscriptProvenance());

    // Assert
    should(refused.message).match(/carries no persisted transfer plan/u);
    should(subject.counts().captures).equal(0);
  });

  it('should refuse a target that has recorded the source session own transcript', async () => {
    // Arrange
    const subject = await harness('source-transcript');
    const bound = subject.bind();
    await bound.lifecycle.create(subject.plan);
    await bound.plans.persist(subject.plan);
    await bound.importer.importPlan(subject.plan, TARGET_ID);
    await subject.storage.updateConfig(
      subject.target,
      current =>
        ({
          ...(current as Record<string, unknown>),
          transcript: subject.plan.source.transcriptProvenance,
        }) as JsonValue,
    );

    // Act
    const refused = await refusal(bound.lifecycle.captureTranscriptProvenance());

    // Assert: a copied provenance points the new session's parser at somebody else's file.
    should(refused.message).match(/records the SOURCE session's transcript/u);
    should(subject.counts().captures).equal(0);
  });

  it('should refuse a foreign but well-formed transcript record rather than launch behind it', async () => {
    // Arrange: a valid minted record for a session in another directory, which is exactly what a
    // substituted target would carry — and what "merely not the source's file" would have accepted.
    const subject = await harness('foreign-transcript');
    const bound = subject.bind();
    await bound.lifecycle.create(subject.plan);
    await bound.plans.persist(subject.plan);
    await bound.importer.importPlan(subject.plan, TARGET_ID);
    await subject.storage.updateConfig(
      subject.target,
      current =>
        ({
          ...(current as Record<string, unknown>),
          transcript: {
            v: 1,
            home: TARGET_HARNESS_HOME,
            harnessSessionId: 'harness-somebody-else',
            identity: 'minted',
            file: harnessFacts.claudeTranscriptFile(TARGET_HARNESS_HOME, '/work/elsewhere', 'harness-somebody-else'),
            resolvedAt: AT,
          },
        }) as JsonValue,
    );

    // Act
    const refused = await refusal(bound.lifecycle.captureTranscriptProvenance());

    // Assert: the file must be the one this target's own launch would write, and the argv must carry
    // the id that makes it true.
    should(refused.message).match(/is not one this fork could have captured/u);
    should(refused.message).match(/recorded transcript file/u);
    should(subject.counts().captures).equal(0);
  });

  it('should refuse an import driven for any id other than the one it is bound to', async () => {
    // Arrange
    const subject = await harness('foreign-import');
    const bound = subject.bind();
    await bound.lifecycle.create(subject.plan);
    await bound.plans.persist(subject.plan);

    // Act
    const foreign = await refusal(bound.importer.importPlan(subject.plan, '20260806-elsewhere'));
    const empty = await refusal(bound.importer.importPlan(subject.plan, ''));

    // Assert
    should(foreign.message).match(/was driven through a surface bound to 20260806-target/u);
    should(empty.message).match(/was driven through a surface bound to 20260806-target/u);
  });

  it('should refuse every write bound to the very source the plan was read from', async () => {
    // Arrange
    const subject = await harness('source-bound');
    const bound = new SessionForkTargetBinder(subject.ports).bind(SOURCE_ID, subject.plan);

    // Act
    const created = await refusal(bound.lifecycle.create(subject.plan));
    const persisted = await refusal(bound.plans.persist(subject.plan));
    const imported = await refusal(bound.importer.importPlan(subject.plan, SOURCE_ID));

    // Assert
    for (const refused of [created, persisted, imported])
      should(refused.message).match(/was bound to its own source 20260806-source/u);
  });

  it('should refuse to bind a surface to an unusable session id', async () => {
    // Arrange
    const subject = await harness('unusable-id');

    // Act
    let refused: unknown;
    try {
      new SessionForkTargetBinder(subject.ports).bind('../escape', subject.plan);
    } catch (error) {
      refused = error;
    }

    // Assert
    should(refused).be.instanceof(SessionForkTargetBindingError);
    should((refused as Error).message).match(/no fork write surface can be bound to it/u);
  });

  it('should refuse a target whose agent no longer resolves to the account the plan was prepared for', async () => {
    // Arrange
    const subject = await harness('account-drift');
    subject.publish({
      account: account({ id: 'acct-somebody-else', kind: 'codex' }),
      executable: '/fleet/bin/claude-auto-zelda',
    });

    // Act
    const refused = await refusal(subject.bind().lifecycle.create(subject.plan));

    // Assert
    should(refused.message).match(/now resolves to account acct-somebody-else \(codex/u);
  });

  it('should report an agent that has left the fleet as an unresolved target, not a broken fork', async () => {
    // Arrange
    const subject = await harness('agent-gone', {
      plan: base => ({ ...base, target: { ...base.target, agent: 'claude-auto-ghost' } }),
    });

    // Act
    let refused: unknown;
    try {
      await subject.bind().lifecycle.create(subject.plan);
    } catch (error) {
      refused = error;
    }

    // Assert: the resolver's own domain error, with the split it owns preserved.
    should(refused).be.instanceof(SessionForkTargetResolutionError);
    should((refused as SessionForkTargetResolutionError).failure).equal('unknown_agent');
  });

  it('should refuse to report a target whose documents cannot be read back', async () => {
    // Arrange: a fork that finished, whose state document has since become unparseable.
    const subject = await harness('unreadable-view');
    await drive(subject);
    damage(subject, FerretStateFile, document => ({ ...document, turn: 'many' }));

    // Act
    const refused = await refusal(subject.bind().lifecycle.view());

    // Assert — refused where the record is first re-proved, before a view could be built from it.
    should(refused.message).match(/cannot be read, so this fork cannot prove it is the target it reserved/u);
  });

  it('should re-prove a completed target before reporting it, rather than simply reading the view', async () => {
    // Arrange: the whole fork, then the drift a completed replay must never report as its outcome.
    const subject = await harness('completed-drift');
    await drive(subject);
    await subject.storage.updateConfig(
      subject.target,
      current => ({ ...(current as Record<string, unknown>), model: 'drifted-model' }) as JsonValue,
    );

    // Act
    const refused = await refusal(subject.bind().lifecycle.view());

    // Assert
    should(refused.message).match(/is not the fresh target plan/u);
    should(refused.message).match(/model/u);
  });

  it('should refuse a completed target whose lineage edge has been altered or removed', async () => {
    // Arrange
    const subject = await harness('edge-drift');
    await drive(subject);
    await subject.storage.updateConfig(subject.target, current => {
      const document = { ...(current as Record<string, unknown>) };
      delete document.transferredFrom;
      return document as JsonValue;
    });

    // Act
    const refused = await refusal(subject.bind().lifecycle.view());

    // Assert
    should(refused.message).match(/carries no transfer edge back to this plan/u);
  });

  it('should refuse a completed target carrying a foreign warden spawn stamp', async () => {
    // Arrange: syntactically valid, and it would shield this session on somebody else's ancestry.
    const subject = await harness('foreign-warden');
    await drive(subject);
    await subject.storage.updateConfig(
      subject.target,
      current =>
        ({
          ...(current as Record<string, unknown>),
          provenance: {
            v: 1,
            at: AT,
            origin: 'warden',
            warden: '20260806-another-warden',
            wardenLineage: true,
            lineageSource: 'parent_stamp',
          },
        }) as JsonValue,
    );

    // Act
    const refused = await refusal(subject.bind().lifecycle.view());

    // Assert
    should(refused.message).match(/spawn provenance/u);
  });

  it('should refuse a second decision written beneath the target under the same plan id', async () => {
    // Arrange: P1 differs only in a facet, and carries P0's deterministic id.
    const subject = await harness('plan-drift');
    const bound = subject.bind();
    await bound.lifecycle.create(subject.plan);
    await bound.plans.persist(subject.plan);
    subject.folder.plant(
      TransferPlanFiles,
      `${JSON.stringify({
        format: 1,
        ...subject.plan,
        facets: {
          ...subject.plan.facets,
          workspace: { ...subject.plan.facets.workspace, head: '0'.repeat(40) },
        },
      })}\n`,
      TARGET_ID,
    );

    // Act
    const imported = await refusal(bound.importer.importPlan(subject.plan, TARGET_ID));
    const captured = await refusal(bound.lifecycle.captureTranscriptProvenance());
    const started = await refusal(bound.lifecycle.start());

    // Assert: a derived plan id is not an identity, so every phase compares the whole value.
    for (const refused of [imported, captured, started])
      should(refused.message).match(/is a DIFFERENT decision under the same id/u);
    should(subject.happened.filter(step => step === 'launch')).eql([]);
  });

  it('should refuse when the record already at the reserved id cannot be read as one', async () => {
    // Arrange
    const subject = await harness('unreadable-record');
    await subject.bind().lifecycle.create(subject.plan);
    await subject.storage.updateConfig(subject.target, current => {
      const document = { ...(current as Record<string, unknown>) };
      delete document.tmuxSession;
      return document as JsonValue;
    });

    // Act
    const refused = await refusal(subject.bind().lifecycle.create(subject.plan));

    // Assert
    should(refused.message).match(/cannot be read, so this fork cannot prove it is the target it reserved/u);
  });
  describe('drift and damage a replay must refuse', () => {
    /** The same ports with a few collaborators swapped, for the failures a real one cannot be made to produce. */
    function bindWith(subject: Harness, swapped: Partial<SessionForkTargetBinderPorts>): SessionForkBoundTarget {
      return new SessionForkTargetBinder({ ...subject.ports, ...swapped }).bind(TARGET_ID, subject.plan);
    }

    /** The real storage with only `updateConfig` replaced, so every other read and write stays the real one. */
    function storageWithUpdateConfig(
      storage: DaemonStorage,
      updateConfig: DaemonStorage['updateConfig'],
    ): DaemonStorage {
      return new Proxy(storage, {
        get: (target, property) => {
          if (property === 'updateConfig') return updateConfig;
          const held: unknown = Reflect.get(target, property, target);
          return typeof held === 'function' ? (held as (...args: unknown[]) => unknown).bind(target) : held;
        },
      });
    }

    /** Create, persist and import: the point after which every later phase re-proves the whole target. */
    async function imported(subject: Harness): Promise<SessionForkBoundTarget> {
      const bound = subject.bind();
      await bound.lifecycle.create(subject.plan);
      await bound.plans.persist(subject.plan);
      await bound.importer.importPlan(subject.plan, TARGET_ID);
      return bound;
    }

    it('should acknowledge an import that already completed without reading the source again', async () => {
      // Arrange: the edge and every artifact are on the target; only the receipt advance was lost.
      const subject = await harness('replayed-import');
      await imported(subject);
      const file = subject.ports.imported.brief.file(TARGET_ID);
      const before = subject.brief();
      const replay = bindWith(subject, {
        importPorts: {
          ...subject.ports.importPorts,
          conversation: {
            digestPinned: async () => {
              throw new Error('the source was read again');
            },
          },
        },
      });

      // Act
      const outcome = await replay.importer.importPlan(subject.plan, TARGET_ID);

      // Assert
      should(outcome.briefPath).equal(file);
      should(outcome.copiedAttachmentIds).eql(subject.plan.facets.attachments.attachments.map(item => item.id));
      should(subject.brief()).equal(before);
    });

    it('should refuse to create when the account no longer serves the context window the plan froze', async () => {
      // Arrange: a window override this daemon carries changed under a frozen plan.
      const subject = await harness('window-drift', {
        plan: base => ({ ...base, target: { ...base.target, contextWindow: 200_000 } }),
      });

      // Act
      const refused = await refusal(subject.bind().lifecycle.create(subject.plan));

      // Assert
      should(refused.message).match(/account claude-auto-zelda no longer serves the target plan plan-fork-1/u);
      should(refused.message).match(/its context window is 1000000 rather than 200000/u);
      should(subject.counts().creates).equal(0);
    });

    it('should refuse a target whose private credential environment cannot be read', async () => {
      // Arrange
      const subject = await harness('environment-unreadable');
      await subject.bind().lifecycle.create(subject.plan);
      const bound = bindWith(subject, {
        environment: {
          read: async () => {
            throw new Error('the environment file is gone');
          },
        },
      });

      // Act
      const refused = await refusal(bound.lifecycle.create(subject.plan));

      // Assert
      should(refused.message).match(/private credential environment cannot be read: the environment file is gone/u);
    });

    it('should refuse a target whose private credential is missing or is not the one its record hashes', async () => {
      // Arrange
      const subject = await harness('credential-mismatch');
      await subject.bind().lifecycle.create(subject.plan);
      const missing = bindWith(subject, { environment: { read: async () => ({}) } });
      const foreign = bindWith(subject, {
        environment: { read: async () => ({ [SESSION_BOARD_CAPABILITY_VARIABLE]: 'somebody-elses-capability' }) },
      });

      // Act
      const absent = await refusal(missing.lifecycle.create(subject.plan));
      const other = await refusal(foreign.lifecycle.create(subject.plan));

      // Assert: a torn creation never launches.
      for (const refused of [absent, other])
        should(refused.message).match(/private credential does not match the hash in its session record/u);
    });

    it('should not refuse a started target whose credential a later launch is re-issuing', async () => {
      // Arrange: past `created`, every pane launch re-issues the credential plaintext-first, so a
      // plaintext its record does not hash yet is a rotation that died before its pane — the next
      // launch heals it, and refusing would wedge the fork behind a pair nothing will ever launch.
      const subject = await harness('credential-rotating');
      await drive(subject);
      const rotating = bindWith(subject, {
        environment: { read: async () => ({ [SESSION_BOARD_CAPABILITY_VARIABLE]: 'the-next-pane-capability' }) },
      });

      // Act
      const actual = await rotating.lifecycle.view();

      // Assert
      should(actual.state.status).equal('running');
    });

    it('should refuse to persist a plan beneath a target that has no session record', async () => {
      // Arrange: a receipt that claims creation although nothing was ever created.
      const subject = await harness('no-record');

      // Act
      const refused = await refusal(subject.bind().plans.persist(subject.plan));

      // Assert
      should(refused.message).match(/has no session record, so plan plan-fork-1 cannot be applied to it/u);
      should(await subject.plans.load(subject.target)).equal(undefined);
    });

    it('should refuse to capture once the opening-turn document no longer matches the plan, and repair it by replaying the import', async () => {
      // Arrange
      const subject = await harness('brief-drift');
      const bound = await imported(subject);
      subject.plantBrief('somebody rewrote the opening turn');

      // Act
      const refused = await refusal(bound.lifecycle.captureTranscriptProvenance());
      await bound.importer.importPlan(subject.plan, TARGET_ID);
      await bound.lifecycle.captureTranscriptProvenance();

      // Assert: a later phase refuses the drift, the import phase re-drives the frozen plan over it.
      should(refused.message).match(/opening-turn document does not match persisted transfer plan plan-fork-1/u);
      should(subject.brief()).equal(assignedTaskDocument(forkOpeningTurn(subject.plan)));
      should(subject.counts().captures).equal(1);
    });

    describe('carried attachments', () => {
      const BYTES = Buffer.from('the quick brown fox');
      const SHA256 = createHash('sha256').update(BYTES).digest('hex');
      const ATTACHMENT_ID = `att_${SHA256}`;
      const manifest = {
        id: ATTACHMENT_ID,
        filename: 'notes.txt',
        mime: 'text/plain',
        size: BYTES.byteLength,
        sha256: SHA256,
        createdAt: AT,
      };

      async function withAttachment(label: string): Promise<Harness> {
        const subject = await harness(label, {
          plan: base => ({
            ...base,
            facets: { ...base.facets, attachments: { attachments: [{ ...manifest, encrypted: null }] } },
          }),
        });
        await subject.attachments.write(
          SOURCE_ID,
          ATTACHMENT_ID,
          'manifest',
          new TextEncoder().encode(JSON.stringify(manifest)),
        );
        await subject.attachments.write(SOURCE_ID, ATTACHMENT_ID, 'original', new Uint8Array(BYTES));
        return subject;
      }

      it('should refuse a later phase when an imported attachment has gone missing, and repair it by replaying the import', async () => {
        // Arrange
        const subject = await withAttachment('attachment-missing');
        const bound = await imported(subject);
        const copied = `${TARGET_ID}/${ATTACHMENT_ID}/original`;
        should(Buffer.from(subject.attachments.files.get(copied) ?? [])).eql(BYTES);
        subject.attachments.files.delete(copied);

        // Act
        const refused = await refusal(bound.lifecycle.captureTranscriptProvenance());
        const outcome = await bound.importer.importPlan(subject.plan, TARGET_ID);
        await bound.lifecycle.captureTranscriptProvenance();

        // Assert
        should(refused.message).match(
          new RegExp(`imported attachment ${ATTACHMENT_ID} does not match persisted transfer plan plan-fork-1`, 'u'),
        );
        should(outcome.copiedAttachmentIds).eql([ATTACHMENT_ID]);
        should(Buffer.from(subject.attachments.files.get(copied) ?? [])).eql(BYTES);
        should(subject.counts().captures).equal(1);
      });

      it('should refuse, not repair, an attachment whose proof fails for any reason but a proved mismatch', async () => {
        // Arrange
        const subject = await withAttachment('attachment-unprovable');
        await imported(subject);
        const bound = bindWith(subject, {
          imported: {
            brief: subject.ports.imported.brief,
            attachments: {
              verifyTarget: async () => {
                throw new Error('the disk went away');
              },
            },
          },
        });

        // Act
        const refused = await refusal(bound.lifecycle.captureTranscriptProvenance());

        // Assert
        should(refused.message).match(
          new RegExp(
            `imported attachment ${ATTACHMENT_ID} cannot be proved against plan plan-fork-1: the disk went away`,
            'u',
          ),
        );
        should(subject.counts().captures).equal(0);
      });
    });

    describe('transcript capture', () => {
      it('should reuse the capture already recorded instead of minting a second one', async () => {
        // Arrange
        const subject = await harness('capture-replay');
        await drive(subject);
        const before = await record(subject);

        // Act
        await subject.bind().lifecycle.captureTranscriptProvenance();

        // Assert
        should(subject.counts().captures).equal(1);
        should((await record(subject)).config.command).eql(before.config.command);
        should(((await subject.storage.readConfig(subject.target)) as Record<string, unknown>).transcript).eql({
          v: 1,
          home: TARGET_HARNESS_HOME,
          harnessSessionId: TARGET_HARNESS_SESSION,
          identity: 'minted',
          file: harnessFacts.claudeTranscriptFile(
            TARGET_HARNESS_HOME,
            subject.plan.durable.cwd,
            TARGET_HARNESS_SESSION,
          ),
          resolvedAt: AT,
        });
      });

      it('should refuse to capture for a target that has already left created without its own provenance', async () => {
        // Arrange: somebody launched the target before its identity was captured.
        const subject = await harness('late-capture');
        const bound = await imported(subject);
        await subject.ports.createLifecycle(subject.target).start(subject.target);

        // Act
        const refused = await refusal(bound.lifecycle.captureTranscriptProvenance());

        // Assert
        should(refused.message).match(/reached lifecycle state \w+ without its own transcript provenance/u);
        should(refused.message).match(/only before its first launch/u);
        should(subject.counts().captures).equal(0);
      });

      it('should refuse to launch a target that has not been through capture', async () => {
        // Arrange
        const subject = await harness('start-uncaptured');
        const bound = await imported(subject);

        // Act
        const refused = await refusal(bound.lifecycle.start());

        // Assert
        should(refused.message).match(
          /no transcript provenance of its own although this fork is past the capture boundary/u,
        );
        should(subject.happened.filter(step => step === 'launch')).eql([]);
      });

      it('should refuse a wrapper that yields no transcript provenance', async () => {
        // Arrange
        const subject = await harness('capture-nothing');
        await imported(subject);
        const bound = bindWith(subject, {
          transcripts: { capture: async () => ({ provenance: undefined, launchArguments: [] }) },
        });

        // Act
        const refused = await refusal(bound.lifecycle.captureTranscriptProvenance());

        // Assert
        should(refused.message).match(/claude wrapper did not yield transcript provenance/u);
        should(((await subject.storage.readConfig(subject.target)) as Record<string, unknown>).transcript).equal(
          undefined,
        );
      });

      it('should refuse to report a capture that was not durable once written', async () => {
        // Arrange: a write that resolves and persists nothing.
        const subject = await harness('capture-lost');
        await imported(subject);
        const lossy = storageWithUpdateConfig(subject.storage, async () => ({}));
        const bound = bindWith(subject, { storage: lossy });

        // Act
        const refused = await refusal(bound.lifecycle.captureTranscriptProvenance());

        // Assert
        should(refused.message).match(/transcript provenance was not durable after capture/u);
      });

      it('should refuse a minted record that names no harness session', async () => {
        // Arrange
        const subject = await harness('undiscovered-claude');
        const bound = await imported(subject);
        await subject.storage.updateConfig(
          subject.target,
          current =>
            ({
              ...(current as Record<string, unknown>),
              transcript: { v: 1, home: TARGET_HARNESS_HOME, identity: 'undiscovered' },
            }) as JsonValue,
        );

        // Act
        const refused = await refusal(bound.lifecycle.captureTranscriptProvenance());

        // Assert
        should(refused.message).match(/recorded transcript identity is "undiscovered" rather than "minted"/u);
        should(subject.counts().captures).equal(0);
      });

      /** A codex target: its rollout can only be attributed through the correlation token its capture declares. */
      async function codexSubject(label: string): Promise<Harness> {
        const codex = account({
          agent: 'codex-auto-zelda',
          kind: 'codex',
          wrapper: '/fleet/bin/codex-auto-zelda',
          defaultModel: 'gpt-5',
          models: [{ id: 'gpt-5', available: true }],
        });
        const planned = planner().plan({
          id: parseSessionId(TARGET_ID),
          account: codex,
          mode: 'auto',
          requestedModel: 'gpt-5',
        });
        if (planned.kind === 'unservable-model') throw new Error(planned.reason);
        const subject = await harness(label, {
          plan: base => ({
            ...base,
            target: {
              ...base.target,
              agent: 'codex-auto-zelda',
              harness: 'codex',
              model: 'gpt-5',
              contextWindow: planned.plan.contextWindow,
            },
          }),
        });
        subject.publish({ account: codex, executable: '/fleet/bin/codex-auto-zelda' });
        return subject;
      }

      it('should accept a replayed codex capture that carries its own correlation token', async () => {
        // Arrange: the real capture's codex arm — a baseline now, the rollout resolved after launch.
        const subject = await codexSubject('correlated-codex');
        let captures = 0;
        const bound = bindWith(subject, {
          transcripts: {
            capture: async request => {
              captures += 1;
              return {
                provenance: {
                  v: 1,
                  home: '/fleet/homes/zelda',
                  identity: 'undiscovered',
                  baseline: [],
                  correlationToken: request.correlationToken,
                },
                launchArguments: codexCorrelationArguments(request.correlationToken),
              };
            },
          },
        });
        await bound.lifecycle.create(subject.plan);
        await bound.plans.persist(subject.plan);
        await bound.importer.importPlan(subject.plan, TARGET_ID);
        await bound.lifecycle.captureTranscriptProvenance();

        // Act: the replay re-proves the record the first capture wrote.
        await bound.lifecycle.captureTranscriptProvenance();

        // Assert
        should(captures).equal(1);
        const command = ((await subject.storage.readConfig(subject.target)) as { command: string[] }).command;
        should(command[0]).equal('/fleet/bin/codex-auto-zelda');
        should(command.slice(-2)).eql([...codexCorrelationArguments(subject.sessionDirectory(TARGET_ID))]);
      });

      it('should refuse a codex record that carries no correlation token of its own', async () => {
        // Arrange
        const subject = await codexSubject('undiscovered-codex');
        const bound = await imported(subject);
        await subject.storage.updateConfig(
          subject.target,
          current =>
            ({
              ...(current as Record<string, unknown>),
              transcript: { v: 1, home: '/fleet/homes/zelda', identity: 'undiscovered' },
            }) as JsonValue,
        );

        // Act
        const refused = await refusal(bound.lifecycle.captureTranscriptProvenance());

        // Assert
        should(refused.message).match(/its correlation token undefined is not this target's own session directory/u);
        should(subject.counts().captures).equal(0);
      });
    });
  });
});

describe('reporting a completed fork whose view cannot be built', () => {
  it('should refuse to report a target whose view the session read cannot answer, whether it fails or finds nothing', async () => {
    // Arrange: the whole fork completed and re-proves; only the view the report is built from is gone.
    const subject = await harness('unviewable');
    await drive(subject);
    const viewless = (view: SessionForkTargetBinderPorts['view']): SessionForkBoundTarget =>
      new SessionForkTargetBinder({ ...subject.ports, view }).bind(TARGET_ID, subject.plan);

    // Act
    const failing = await refusal(
      viewless(async () => {
        throw new Error('the documents could not be parsed');
      }).lifecycle.view(),
    );
    const missing = await refusal(viewless(async () => undefined).lifecycle.view());

    // Assert
    for (const refused of [failing, missing])
      should(refused.message).equal(
        `target ${TARGET_ID} was written but its documents do not satisfy the protocol, so this fork cannot be reported`,
      );
  });
});
