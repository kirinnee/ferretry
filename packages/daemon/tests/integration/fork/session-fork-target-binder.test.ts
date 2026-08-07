import { afterEach, describe, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { truncate, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type RuntimeControlRequest,
  SessionConfigSchema,
  SessionStateSchema,
  type SessionTransferPlan,
  type SessionView,
} from '@ferretry/protocol';
import should from 'should';
import {
  SessionForkTargetBinder,
  type SessionForkTargetBinderPorts,
  SessionForkTargetBindingError,
  forkOpeningTurn,
} from '../../../src/adapters/fork/session-fork-target-binder.ts';
import {
  SessionForkTargetResolutionError,
  type SessionForkTargetAccount,
} from '../../../src/adapters/fork/session-fork-target-resolver.ts';
import { FileSessionTaskStore } from '../../../src/adapters/session/lifecycle/file-session-task-store.ts';
import { NodeWorkingDirectoryResolver } from '../../../src/adapters/session/lifecycle/node-working-directory-resolver.ts';
import {
  type SessionProtocolEnvelope,
  StorageSessionLifecycleRepository,
} from '../../../src/adapters/session/lifecycle/storage-session-lifecycle-repository.ts';
import type { DaemonStorage } from '../../../src/adapters/storage/session-storage.ts';
import { FileSessionAttachmentCopier } from '../../../src/adapters/transfer/attachment-copier.ts';
import { FileSessionTransferBriefWriter } from '../../../src/adapters/transfer/brief-writer.ts';
import { FileSessionTransferPlanStore } from '../../../src/adapters/transfer/plan-store.ts';
import { StorageTransferEnvelopeWriter } from '../../../src/adapters/transfer/storage-transfer-envelope-writer.ts';
import { KeyedSerialExecutor } from '../../../src/adapters/index.ts';
import type { SessionForkBoundTarget } from '../../../src/lib/fork/types.ts';
import type { SessionEffectKey, SessionEffectLedger } from '../../../src/lib/session/effects/index.ts';
import { assignedTaskDocument } from '../../../src/lib/session/lifecycle/policy.ts';
import { sessionTmuxName } from '../../../src/lib/session/lifecycle/policy.ts';
import { startupModelArguments } from '../../../src/lib/session/harness/startup.ts';
import { claudeSessionArguments, claudeTranscriptFile } from '../../../src/lib/session/transcript/claude-path.ts';
import { SessionLifecycleService } from '../../../src/lib/session/lifecycle/service.ts';
import { defaultSessionLifecycleSettings } from '../../../src/lib/session/lifecycle/settings.ts';
import { MAX_ASSIGNED_TASK_LENGTH } from '../../../src/lib/session/lifecycle/types.ts';
import type { JsonValue } from '../../../src/lib/json.ts';
import type { SessionLifecycleRecord } from '../../../src/lib/session/lifecycle/types.ts';
import { type SessionId, parseSessionId } from '../../../src/lib/session-id.ts';
import type { TransferConversationValidator } from '../../../src/lib/transfer/types.ts';
import {
  AT,
  SOURCE_ID,
  TARGET_ID,
  account,
  cleanup,
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

/** A fixture-local durable-effect stand-in: every lifecycle rebuilt by one harness shares it. */
function memoryEffectLedger(): SessionEffectLedger {
  const held = new Map<string, { readonly fingerprint: string; readonly settled: boolean }>();
  const identity = (key: SessionEffectKey): string => JSON.stringify([key.sessionId, key.effectId]);

  return {
    inspect: async (key, fingerprint) => {
      const effect = held.get(identity(key));
      if (effect === undefined) return 'unclaimed';
      if (effect.fingerprint !== fingerprint) return 'conflict';
      return effect.settled ? 'settled' : 'unsettled';
    },
    begin: async (key, fingerprint) => {
      const effect = held.get(identity(key));
      if (effect !== undefined) {
        if (effect.fingerprint !== fingerprint) return 'conflict';
        return effect.settled ? 'settled' : 'unsettled';
      }
      held.set(identity(key), { fingerprint, settled: false });
      return 'perform';
    },
    settle: async (key, fingerprint) => {
      const effect = held.get(identity(key));
      if (effect === undefined || effect.fingerprint !== fingerprint)
        throw new Error(`cannot settle unclaimed or conflicting effect ${key.effectId}`);
      held.set(identity(key), { fingerprint, settled: true });
    },
  };
}

/** The runtime subsystem's opaque comparison, repeated only by this stateful port stand-in. */
function runtimeEffectFingerprint(request: RuntimeControlRequest): string {
  return JSON.stringify([
    request.action,
    request.action === 'compact' ? null : (request.effort ?? null),
    request.action === 'model' ? (request.model ?? null) : null,
  ]);
}

interface Harness {
  readonly ports: SessionForkTargetBinderPorts;
  readonly storage: DaemonStorage;
  readonly plan: SessionTransferPlan;
  readonly target: SessionId;
  readonly sessionDirectory: (id: string) => string;
  /** Everything the launcher and the runtime path did, in the order it happened. */
  readonly happened: string[];
  readonly plans: FileSessionTransferPlanStore;
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

  const plans = new FileSessionTransferPlanStore(
    planId => join(opened.home, 'state', 'forks', `${planId}.json`),
    id => join(opened.sessionDirectory(id), 'transfer-plan.json'),
  );
  const briefWriter = new FileSessionTransferBriefWriter(id => opened.sessionDirectory(id));
  const attachmentCopier = new FileSessionAttachmentCopier(id => join(opened.sessionDirectory(id), 'attachments'));
  const tasks = new FileSessionTaskStore(id => opened.sessionDirectory(id));

  const ports: SessionForkTargetBinderPorts = {
    storage: opened.storage,
    createLifecycle: (id: SessionId, envelope?: SessionProtocolEnvelope) =>
      new SessionLifecycleService(
        {
          repository: new StorageSessionLifecycleRepository(opened.storage, envelope),
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
              return await tasks.writeAssignedTask(held, document);
            },
          },
          effects,
          directories: new NodeWorkingDirectoryResolver(),
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
      read: async id => await plans.loadTargetPlan(id),
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
            file: claudeTranscriptFile(TARGET_HARNESS_HOME, request.cwd, TARGET_HARNESS_SESSION),
            resolvedAt: AT,
          },
          launchArguments: [...claudeSessionArguments(TARGET_HARNESS_SESSION)],
        };
      },
    },
    importPorts: {
      envelope: new StorageTransferEnvelopeWriter(opened.storage),
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
    view: async id => await view(opened.storage, opened.sessionDirectory, id).catch(() => undefined),
    sessionDirectory: id => opened.sessionDirectory(id),
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
    storage: opened.storage,
    plan: frozen,
    target,
    sessionDirectory: opened.sessionDirectory,
    happened,
    plans,
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
  await truncate(join(subject.sessionDirectory(TARGET_ID), 'events.jsonl'), 0);
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
    should(held.config.sessionCapabilityHash).equal(CAPABILITY_HASH);
    should(started.config.incarnation).equal(`${TARGET_ID}-1`);
    should(started.config.runtimeGeneration).equal(1);
    should(started.config.boardAccess).equal('none');
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
      '--dangerously-skip-permissions',
      ...startupModelArguments('claude-opus-5'),
      ...LAUNCH_ARGUMENTS,
    ]);
    // The plan is durable beneath the target, so a later replay reads it rather than the source.
    should((await subject.plans.loadTargetPlan(subject.target))?.planId).equal(subject.plan.planId);
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

    // Assert: never silently launch a session at a model the caller was not shown.
    should(refused.message).match(/no longer serves the target plan/u);
    should(refused.message).match(/its model is "claude-sonnet-5" rather than "claude-opus-5"/u);
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
    const file = join(subject.sessionDirectory(TARGET_ID), 'turns', 'turn-001.md');

    // Act
    const bound = subject.bind();
    await bound.lifecycle.create(subject.plan);
    await bound.plans.persist(subject.plan);
    const outcome = await bound.importer.importPlan(subject.plan, TARGET_ID);
    const imported = await readFile(file, 'utf8');
    await bound.lifecycle.captureTranscriptProvenance();
    await bound.lifecycle.start();

    // Assert: the two writers of one document cannot tear each other, and a replay of either
    // converges on the same bytes rather than oscillating between two spellings of one brief.
    should(outcome.briefPath).equal(file);
    should(imported).equal(assignedTaskDocument(forkOpeningTurn(subject.plan)));
    should(await readFile(file, 'utf8')).equal(imported);
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
    const file = join(subject.sessionDirectory(TARGET_ID), 'events.jsonl');
    await Bun.write(file, `${JSON.stringify(forged)}\n`);
    const before = await readFile(file, 'utf8');

    // Act
    const refused = await refusal(subject.bind().lifecycle.create(subject.plan));

    // Assert: refusal is about the missing first boundary, and the forged journal is untouched.
    should(refused.message).match(/creation boundary has sequence 2/u);
    should(refused.message).match(/first lifecycle event must have sequence 1/u);
    should(await readFile(file, 'utf8')).equal(before);
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
          boardAccess: 'worker',
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
        tasks: new FileSessionTaskStore(id => subject.sessionDirectory(id)),
        effects: memoryEffectLedger(),
        directories: new NodeWorkingDirectoryResolver(),
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
    should(refused.message).match(/board access/u);
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
    await subject.storage.updateConfig(subject.target, current => {
      const document = { ...(current as Record<string, unknown>) };
      delete document.retry;
      return document as JsonValue;
    });

    // Act
    const refused = await refusal(subject.bind().lifecycle.create(subject.plan));

    // Assert
    should(refused.message).match(/does not satisfy the protocol/u);
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
    await Bun.write(subject.plans.targetPlanPath(subject.target), '{ not json');

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
            file: claudeTranscriptFile(TARGET_HARNESS_HOME, '/work/elsewhere', 'harness-somebody-else'),
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
    await subject.storage.updateState(
      subject.target,
      current => ({ ...(current as Record<string, unknown>), turn: 'many' }) as JsonValue,
    );

    // Act
    const refused = await refusal(subject.bind().lifecycle.view());

    // Assert
    should(refused.message).match(/do not satisfy the protocol, so this fork cannot be reported/u);
  });

  it('should re-prove a completed target before reporting it, rather than simply reading the view', async () => {
    // Arrange: the whole fork, then the drift a completed replay must never report as its outcome.
    const subject = await harness('completed-drift');
    await drive(subject);
    await subject.storage.updateConfig(
      subject.target,
      current => ({ ...(current as Record<string, unknown>), boardAccess: 'worker' }) as JsonValue,
    );

    // Act
    const refused = await refusal(subject.bind().lifecycle.view());

    // Assert
    should(refused.message).match(/is not the fresh target plan/u);
    should(refused.message).match(/board access/u);
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
    await Bun.write(
      subject.plans.targetPlanPath(subject.target),
      `${JSON.stringify({
        ...subject.plan,
        facets: {
          ...subject.plan.facets,
          workspace: { ...subject.plan.facets.workspace, head: '0'.repeat(40) },
        },
      })}\n`,
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
});
