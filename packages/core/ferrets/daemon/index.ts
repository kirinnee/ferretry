import { randomBytes } from 'node:crypto';
import type { BearerDigest } from '@ferretry/core-gate/contract';
import {
  ApiError,
  type CallContext,
  decodeParameter,
  type FencedPath,
  type PinnedWorkingDirectory,
} from '@ferretry/kernel/contract';
import { type DaemonContext, type DaemonHalf, implementDaemon, perNeeder } from '@ferretry/kernel/manifest';
import { err, milliseconds, ok, type Result } from '@ferretry/std';
import {
  type FerretId,
  type Runner,
  type RunnerHandle,
  FerretChanged,
  FerretStopping,
  FerretStarted,
  FerretFiles,
  type FerretIngestEvidence,
  type FerretRecord,
  type FerretState,
  FerretsChanged,
  FerretTokensFile,
  type HarnessKey,
  LimitsConfigFile,
  FerretLaunchSectionsFiles,
  Harnesses,
  LAUNCH_ROOTS_KEY,
  LaunchRoots,
  Logins,
  type LoginKind,
  LaunchParts,
  OPENING_ATTACHMENTS_KEY,
  OpeningAttachments,
  Runners,
  RUNTIME_START_KEY,
  RuntimeStart,
  SitrepLines,
  StartDecide,
  AgentPinsFile,
  FerretDetailsFile,
  FerretLaunchEnvironmentFiles,
  FerretSummaryFiles,
  FerretWaitFiles,
} from '../contract/index.ts';
import manifest from '../manifest.ts';
import { archivedNameClaims } from './lib/names/session-names.ts';
import { ferretsPort } from './lib/ferrets/port.ts';
import { turnWatchFailureFields } from './modules/turn-watch.ts';
import { outdatedMark } from './lib/fleet-list/outdated-mark.ts';
import { FerretsService, type FerretsPorts } from './lib/ferrets/service.ts';
import { helperDecision, noHelperAdmission } from './lib/ferrets/helper-admission.ts';
import { stopUnconfirmedIn } from './lib/ferrets/restart-guards.ts';
import { type SessionId, tryParseSessionId } from './lib/session-id.ts';
import { DEFAULT_CALLSIGN_POOL, NameAllocator, SystemCallsignIssuer } from './lib/names/index.ts';
import type { NameClaim } from './lib/names/types.ts';
import { LedgerNameClaimStore, stateClaimLedger } from './adapters/names/name-claim-store.ts';
import { StateCallsignCounters } from './adapters/names/state-callsign-counters.ts';
import { ambiguousAgentAddressMessage, resolveAgentAddress } from '../contract/agent-address.ts';
import { FerretRegistry } from './lib/registry/registry.ts';
import { heldLifecycleLauncher } from './adapters/session/lifecycle/ferret-session-lifecycle-launcher.ts';
import { ConversationLeaseStateDisk } from './adapters/session/lifecycle/conversation-lease-disk.ts';
import { processIncarnationFor } from './adapters/session/lifecycle/process-incarnation.ts';
import { ConversationLeaseStore } from '../contract/conversation-lease.ts';
import { ConversationLeases, registryLeaseSessions } from './lib/session/lifecycle/conversation-leases.ts';
import { FerretTokenDirectory, type TokenEntry } from './lib/tokens/tokens.ts';
import { DirectoryCutOff } from './lib/tokens/cut-off-mark.ts';
import { instructionsAnswer } from './lib/agent-control/instructions.ts';
import { LaunchEnvironmentStore, switchesOfRecord } from './lib/agent-control/launch-environment.ts';
import { agentControlReader } from './lib/agent-control/reader.ts';
import { RegistryWorkFolders } from './lib/work-folders/work-folders.ts';
import { ferretsAgendaContext } from './modules/agenda-context.ts';
import { SessionFilesystem } from './lib/session/filesystem/index.ts';
import { KernelGitRunner } from './adapters/git/runner.ts';
import { KernelDiffScratch, KernelSessionRootPinner, RunnerSessionGit } from './adapters/session/filesystem/index.ts';
import { StateAgentPinRepository } from './adapters/agent-pins/index.ts';
import { KeyedSerialExecutor } from './adapters/storage/keyed-serial-executor.ts';
import type { StateHomeLaunchReach } from './lib/route-security/state-home.ts';
import { AgentPinService } from './lib/agent-pins/index.ts';
import { DaemonStorage } from './adapters/storage/session-storage.ts';
import { SessionFiles, type SessionFilesDeps } from './modules/session-files.ts';
import { HistoryEventSource } from './modules/fleet-events.ts';
import { folderLister } from './lib/ferrets/folder-listing.ts';
import { callerIsAgent } from './lib/ferrets/launch-origin.ts';
import { SessionConfigSchema, SessionStateSchema } from './lib/protocol/session.ts';
import { displayModel, ingestEvidence } from './lib/protocol/session-subtree.ts';
import { livePaneLimits } from './lib/ferrets/pane-limits.ts';
import { promptOf } from './lib/ferrets/prompt.ts';
import { FileLastSnapshotStore } from './adapters/session/snapshot/file-last-snapshot-store.ts';
import { LastSnapshotCapture } from './lib/session/snapshot/capture.ts';
import { LastSnapshotReading } from './lib/session/snapshot/read.ts';
import { HarnessTranscript } from './adapters/session/live/harness-transcript.ts';
import { applicableInstructions, outdatedSectionIds, sectionDigests } from './lib/ferrets/launch-sections.ts';
import type { LaunchInstructionSectionId } from './lib/protocol/session.ts';
import { lifecycleStatus, withLifecycleStatus } from './lib/ferrets/session-document.ts';
import features from './generated/features.ts';
import { callerFerret, NOT_OWN_FERRET_CODE } from './features/caller.ts';
import { registerFeatures } from './features/compose.ts';
import { LaunchStepRegistry } from './lib/ferrets/launch-steps.ts';
import { TURN_WATCH_JOB } from './features/turn-watch.feature.ts';
import type { FerretsContext, LateBindings } from './features/types.ts';

export { callerFerret, NOT_OWN_FERRET_CODE, TURN_WATCH_JOB };

/** A random ferret id: base-36 time + 8 hex characters (today's `TimeSessionIdFactory`). */
const mintId = (nowMs: number): FerretId => `${nowMs.toString(36)}-${randomBytes(4).toString('hex')}` as FerretId;

function build(ctx: DaemonContext<typeof manifest>): DaemonHalf<typeof manifest> {
  const { kernel, hooks, needs } = ctx;
  const log = kernel.log.child('ferrets');
  let generation = 0;
  // I108: publish at the registry mutation, including removal, after the service's durable write.
  const registry = new FerretRegistry([], change => {
    generation += 1;
    kernel.events.publish(FerretsChanged, { ...change, generation });
  });
  const tokens = new FerretTokenDirectory();
  const workFolders = new RegistryWorkFolders(registry);

  // Load what is held. Sync answers (`mayTouch`, `bearers:ferret`, `WorkFolders`) see nothing until this lands,
  // which fails closed: an unknown ferret is refused, an unknown digest is no ferret.
  // Whether every record the state lists was read whole (its record, and its details file): a roster with one missing
  // is not the truth about who exists, and a reader that would CLEAR something for a ferret not in it must be able to ask.
  let wholeRoster = true;
  const loaded = (async () => {
    for (const name of await kernel.state.list(FerretFiles)) {
      const read = await kernel.state.read(FerretFiles, name);
      if (read.ok && read.value !== undefined) registry.put(read.value);
      else if (!read.ok) log.warn('a ferret record could not be read', { file: read.error.file });
      if (!read.ok || read.value === undefined) {
        wholeRoster = false;
        continue;
      }
      // Its start options and title, kept beside the record so a list or a read stays memory-only.
      const details = await kernel.state.read(FerretDetailsFile, name);
      if (details.ok && details.value !== undefined) registry.putDetails(read.value.id, details.value);
      else if (!details.ok) {
        wholeRoster = false;
        log.warn('a ferret details file could not be read', { file: details.error.file });
      }
      // Its declared wait, if it was parked when the daemon last ran.
      const wait = await kernel.state.read(FerretWaitFiles, name);
      if (wait.ok && wait.value?.waiting !== undefined) registry.putWaiting(read.value.id, wait.value.waiting);
      if (wait.ok && wait.value?.finishedAt !== undefined) registry.putFinished(read.value.id, wait.value.finishedAt);
      if (!wait.ok) log.warn('a ferret waiting file could not be read', { file: wait.error.file });
    }
    const held = await kernel.state.read(FerretTokensFile);
    // An unreadable/missing token document beside existing records cannot prove no owner cut-off was held.
    if (!held.ok || (held.value === undefined && registry.list().length > 0)) tokens.unavailable();
    if (held.ok && held.value !== undefined) for (const entry of held.value.tokens) tokens.add(entry as TokenEntry);
  })();
  const ready = async (): Promise<void> => {
    await loaded;
  };

  // The owner's sidebar pins (agent-pins.json): the service marks `pinnedAt` on each summary from them.
  const pinClock = { now: () => kernel.clock.now() };
  const agentPins = new AgentPinService(
    new StateAgentPinRepository(kernel.state, AgentPinsFile),
    pinClock,
    new KeyedSerialExecutor(),
  );

  // The journal stream's source: each ferret's history.jsonl, and the append edge below.
  const eventSource = new HistoryEventSource(kernel.state, () => registry.list().map(ferret => ferret.id));

  /** A ferret's `waiting.json`, or an empty one: what it declared, the time credited for it, and when it finished. */
  const parkedFile = async (ferret: FerretId) => {
    const read = await kernel.state.read(FerretWaitFiles, ferret);
    return read.ok && read.value !== undefined ? read.value : {};
  };

  // The session store and the ferret's private session files. Everything a session keeps that is a credential or an
  // irreversible-act record sits on the internal `sessions` root (one minted ferret folder per handle), never on `work`.
  // The archive the store keeps is read before the first move or fork route answers.
  const sessionStore = new DaemonStorage(kernel.state, { now: () => kernel.clock.now() }, log);
  const storeLoaded = sessionStore.loadArchive().catch((error: unknown) => {
    log.warn('the session store could not load its archive', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  });
  /**
   * A ferret's history event, without the session index. The storage's own `appendHistory` owns the sequence: it runs in
   * the same session lane as `sessionStore.append`, so a ferret's history and its session journal never share a number.
   */
  const appendHistory = async (ferret: FerretId, type: string, data: Readonly<Record<string, unknown>>) =>
    await sessionStore
      .appendHistory(ferret as unknown as SessionId, type, data)
      .then(event => {
        eventSource.publish({
          sequence: event.sequence,
          sessionId: event.sessionId,
          time: event.time,
          type: event.type,
          data: event.data,
        });
      })
      .catch((error: unknown) =>
        log.warn('a ferret history event could not be recorded', {
          ferret,
          type,
          error: error instanceof Error ? error.message : String(error),
        }),
      );

  // ONE executor for the callsign ledger: what makes a claim atomic across concurrent starts and renames.
  const callsignSerial = new KeyedSerialExecutor();
  // What the fleet holds: its records, and the sessions the archive took out of the live set (they keep their name for the
  // same window, so `fy send <name>` never meets a second session of that name).
  const heldClaims = (): readonly NameClaim[] => [
    ...registry.nameClaims(),
    ...archivedNameClaims(sessionStore.listArchivedSessions()),
  ];
  const claimStore = new LedgerNameClaimStore(stateClaimLedger(kernel.state), callsignSerial, heldClaims);
  // The archived half of what is held is known only once the store's archive is loaded: every allocation and every
  // "what is held" answer waits for it (a load that failed holds no archived name, as a store with no archive).
  const archiveRead = async (): Promise<void> => {
    await storeLoaded.catch(() => undefined);
  };
  const claims = {
    allocate: async (request: Parameters<NameAllocator['allocate']>[0]) => {
      await archiveRead();
      return await new NameAllocator(claimStore, {
        // Rotating the pick so two starts racing for the pool do not both begin at its first entry.
        nextIndex: upperExclusive => Math.floor(Math.random() * upperExclusive),
      }).allocate(request);
    },
    release: async (callsign: string, ownerId: string) => await claimStore.release(callsign, ownerId),
  };
  const systemCallsigns = new SystemCallsignIssuer({
    counters: new StateCallsignCounters(kernel.state),
    // Every callsign the fleet holds or has held, expired claims included, as today's `held`: a stopped ferret's id is
    // never issued again.
    held: async () => {
      await archiveRead();
      return heldClaims().map(claim => claim.callsign);
    },
    serial: callsignSerial,
  });

  const saveTokens = async (entries: readonly TokenEntry[]): Promise<void> =>
    await kernel.state.write(FerretTokensFile, {
      format: 1,
      tokens: entries.map(entry => ({ ...entry })) as never,
    });
  // The token directory's half of an owner's cut-off, as the lifecycle's hash store reaches it: after the held tokens
  // load (an unloaded directory would read "not cut off"), and each write persists `tokens.json`.
  const tokenCutOff = new DirectoryCutOff({ ready, tokens, save: saveTokens, now: () => kernel.clock.now() });
  const runnerOf = (): Runner | undefined => {
    const found = hooks.provider(Runners, 'tmux');
    return found === 'unavailable' ? undefined : found;
  };
  // One set of conversation leases for the whole daemon: the lifecycle claims through it before a pane exists, and Ferrets'
  // launch (the ONE place every pane opens) holds the pane's conversation on it and frees it when the ferret stops.
  const conversationLeases = new ConversationLeases(
    new ConversationLeaseStore(
      new ConversationLeaseStateDisk(
        kernel.state,
        processIncarnationFor(kernel.hostFacts, kernel.spawn),
        { nowMs: () => kernel.clock.nowMs(), sleep: async ms => await kernel.clock.sleep(milliseconds(ms)) },
        kernel.hostFacts.platform,
      ),
      () => new Date(kernel.clock.nowMs()),
    ),
    registryLeaseSessions(registry, async id => await sessionStore.readState(id)),
    process.pid,
  );

  const sessionFilesDeps = {
    // The members marked `satisfies` at the end are REQUIRED here (a daemon without them runs a second cut-off fact or no
    // pane launcher), though a unit fixture may leave them off.
    tokenCutOff,
    // The lifecycle's pane launcher: a thin adapter over Ferrets' own launch and stop (the held variants, the lifecycle
    // holds the ferret's key on the shared queue), so a lifecycle opens a pane through the ONE launch path. `service` is
    // built below; every call here is made after it exists.
    launcher: heldLifecycleLauncher(() => service, {
      handleOf: ferret => registry.get(ferret)?.handle as RunnerHandle | undefined,
      runner: runnerOf,
      sleep: async ms => await kernel.clock.sleep(milliseconds(ms)),
      nowMs: () => kernel.clock.nowMs(),
    }),
    // One live writer per harness conversation, claimed before a pane exists. The disk is the daemon's twin of what
    // `fy history claim` reads and locks (the same files and the same `flock`), so a wrapper's claim in a pane and this
    // one decide against one set of leases; the holder is the session plus this daemon's pid until the lifecycle (or
    // Ferrets' launch) moves it onto the pane's.
    leases: conversationLeases,
    roots: kernel.roots,
    storage: sessionStore,
    clock: { now: () => kernel.clock.now() },
    sleep: async delay => await kernel.clock.sleep(delay),
    paths: kernel.paths,
    // The requested label and parent: lineage uses them only for a ferret with no session document yet.
    fleet: () =>
      registry.list().map(ferret => {
        const label = registry.detailsOf(ferret.id)?.options?.label;
        return {
          id: ferret.id,
          ...(label === undefined ? {} : { label }),
          ...(ferret.parent === undefined ? {} : { parent: ferret.parent }),
        };
      }),
    // What a ferret's session document is made from (ruling #31b): its record and its start options.
    seed: id => {
      const record = registry.get(id as unknown as FerretId);
      return record === undefined ? undefined : { record, details: registry.detailsOf(record.id) };
    },
    log,
  } satisfies SessionFilesDeps & Required<Pick<SessionFilesDeps, 'tokenCutOff' | 'launcher' | 'leases'>>;
  const sessionFiles = new SessionFiles(sessionFilesDeps);
  // Every held ferret gets its session document once the records and the store's archive are loaded, before any start
  // or resume reads the fleet's lineage (which refuses while an indexed ferret has none). Each stamp waits for it.
  void sessionFiles
    .backfill(async () => {
      await loaded;
      await storeLoaded.catch(() => undefined);
      return registry.list().map(ferret => ferret.id);
    })
    .catch((error: unknown) =>
      log.warn('the ferret session documents could not be checked at boot', {
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  // The launch environment: ONE store, written by every launch and read by `instructions` (stored over what the record
  // implies; RULING #30). Each section's flag is its OWNER's launch part: Pack's `FY_PACK`, Agenda's `FY_AGENDA` and
  // Conversation's `conversation-hypermedia` (FY_HYPERMEDIA, only when the owner set the ferret's switch) are registered.
  // Lessons' `FY_LEARNING_PASSIVE` is registered too. With no hypermedia switch set, the launch itself hands the pane
  // (and records) the mode's default (`modeSwitchDefaults`: on for an interactive ferret, off for an auto one).
  // Until each lands its section is not recorded, and `instructions` reads it as off: no stand-in. Each is one line in
  // ports-pending.json under its owner (ferrets).
  const launchEnvironment = new LaunchEnvironmentStore(
    {
      read: async ferret => {
        const read = await kernel.state.read(FerretLaunchEnvironmentFiles, ferret);
        return read.ok ? (read.value ?? {}) : {};
      },
      write: async (ferret, environment) => await kernel.state.write(FerretLaunchEnvironmentFiles, environment, ferret),
    },
    async ferret => switchesOfRecord(registry.get(ferret), registry.detailsOf(ferret)),
  );

  // The state document's LIFECYCLE status follows the registry (U4): made `starting`, it moves to `running` once the
  // launch settles and to `stopped` at a stop, as today's lifecycle moved it (`lifecycleStatus`). The turn watch's writer
  // re-reads that status under the lock, so a document left `starting` would never be given a turn. One lane per
  // ferret, in the order the registry changed; a ferret with no document yet is left alone.
  const statusLane = new KeyedSerialExecutor();
  const followStatus = (ferret: FerretId, state: FerretState, cause: 'lifecycle' | 'reconcile'): void => {
    const id = tryParseSessionId(ferret);
    if (id === undefined) return;
    void statusLane
      .run(ferret, async () => {
        if ((await sessionStore.readState(id).catch(() => undefined)) === undefined) return;
        await sessionStore.updateState(id, raw => {
          const current = SessionStateSchema.safeParse(raw);
          const next = current.success ? lifecycleStatus(current.data.status, state, cause) : undefined;
          return next === undefined
            ? raw
            : withLifecycleStatus(raw as Record<string, unknown>, next, kernel.clock.now());
        });
      })
      .catch((error: unknown) =>
        log.warn("a ferret's state document could not follow its lifecycle", {
          ferret,
          ...turnWatchFailureFields(error),
        }),
      );
  };

  // An ended ferret's `environment.json` (its plaintext `fys_` credential, dead now) is deleted: on every edge to
  // `stopped` (a normal end, a failed launch, a kill: each writes that edge) and, at arm, for every ferret already
  // stopped (a crash, or an end this code did not yet delete). Best effort and logged: a failure never fails the end.
  const removeEnvironment = (ferret: FerretId): void => {
    const id = tryParseSessionId(ferret);
    if (id === undefined) return;
    void sessionFiles
      .removeEnvironment(id, () => registry.get(ferret)?.state === 'stopped')
      .catch((error: unknown) =>
        log.warn("an ended ferret's environment file could not be removed", {
          ferret,
          ...turnWatchFailureFields(error),
        }),
      );
  };

  // The ferret's last screen, kept as it stops (F-0326): one `Runner.look` (an act on the pane, masked by the runner),
  // masked again here, written 0600 to its own folder on the sessions root, bounded by the kernel clock.
  const lastSnapshots = new LastSnapshotCapture({
    // read-scoped: none — a factory typed LastSnapshotWriter (write only); the frame it is handed was masked inside Redaction.read in LastSnapshotCapture.captureOnce
    store: id => new FileLastSnapshotStore(sessionFiles.root(id), id),
    redaction: kernel.redaction,
    sleep: async (delay, signal) => await kernel.clock.sleep(delay, signal),
    log,
    yieldToLoop: async () => await kernel.clock.sleep(milliseconds(0)),
  });
  // The ferret's stored last screen, read back (`FerretsApi.lastSnapshot`): masked AGAIN on every read.
  const lastSnapshotReading = new LastSnapshotReading({
    // read-scoped: none — a factory typed LastSnapshotReader (read only); the text it returns is masked inside Redaction.read in LastSnapshotReading.read before it leaves
    store: id => new FileLastSnapshotStore(sessionFiles.root(id), id),
    redaction: kernel.redaction,
    yieldToLoop: async () => await kernel.clock.sleep(milliseconds(0)),
  });

  // What a feature builds that this composition's ports reach lazily: the turn watch's wake-up, the managed worktrees and
  // the moves. Assigned when the features register, read only when a call is made.
  const late: LateBindings = {};
  const lateOf = <T>(held: T | undefined, feature: string): T => {
    if (held === undefined) throw new Error(`ferrets: the ${feature} feature is not registered`);
    return held;
  };
  /** The `logins:<kind>` provider that holds the named login, or why none does. */
  const loginKindOf = (login: string): Result<LoginKind, string> => {
    const kinds = [...hooks.providers(Logins).values()];
    if (kinds.length === 0) return err(`no login provider is running, so the login ${login} cannot be used`);
    const kind = kinds.find(candidate => candidate.holds(login));
    return kind === undefined
      ? err(`there is no login named ${login} on this machine, so the ferret was not started`)
      : ok(kind);
  };
  const answered = async <T>(login: string, read: () => Promise<T>): Promise<Result<T, string>> => {
    try {
      return ok(await read());
    } catch {
      return err(`the login ${login} could not be read, so the ferret was not started`);
    }
  };
  // What features add to a launch (a pane variable each); sealed once they have registered, below.
  const launch = new LaunchStepRegistry();
  const servicePorts = {
    launchEnvironment,
    launchSections: {
      write: async (ferret, sections) => await kernel.state.write(FerretLaunchSectionsFiles, { sections }, ferret),
      forget: async ferret => await kernel.state.remove(FerretLaunchSectionsFiles, ferret),
    },
    ready,
    wholeRoster: () => wholeRoster,
    launchSteps: launch,
    session: sessionFiles.port,
    claims,
    systemCallsign: async prefix => await systemCallsigns.next(prefix),
    now: () => kernel.clock.now(),
    newId: () => mintId(kernel.clock.nowMs()),
    newName: taken =>
      DEFAULT_CALLSIGN_POOL.find(candidate => !taken(candidate)) ?? `ferret-${randomBytes(3).toString('hex')}`,
    save: async (record: FerretRecord) => await kernel.state.write(FerretFiles, record, record.id),
    saveTokens,
    // ONE queue and ONE cut-off fact with the lifecycle (`SessionFiles`): a start, a stop and a resume here and a
    // lifecycle's launch of the same ferret never interleave, and a cut-off is read from and written to both halves.
    serial: sessionFiles.serial,
    // The same gate the lifecycle's stop wait and the interrupted-launch reconciler read: this service's launches register in it.
    launches: sessionFiles.launchGate,
    cutOffMark: sessionFiles.cutOffMark,
    // A resume refuses over a stop nobody confirmed: the state document says `kill_failed` (a missing one says nothing).
    stopUnconfirmed: async ferret => {
      const id = tryParseSessionId(ferret);
      return id !== undefined && stopUnconfirmedIn(await sessionStore.readState(id));
    },
    harness: key => {
      const found = hooks.provider(Harnesses, key);
      return found === 'unavailable' ? undefined : found;
    },
    harnessKeys: () => [...hooks.providers(Harnesses).keys()] as HarnessKey[],
    runner: runnerOf,
    decide: async input => {
      // RULING #43: today's pack.admit was mandatory for a child start, and Packs owns that answer on start.decide. A
      // child start or resume is admitted only when Packs ITSELF answered (its yes, or its no with its reason); no
      // answer from Packs (absent, failed, a hang, a throw, garbage) is 503 `helper_admission_unavailable`, before
      // anything is written or launched. The kernel bounds and normalizes every taker, Packs included. `by: 'resume'`
      // is set here by Ferrets' own resume, never by a caller (a start's `by` cannot name it).
      const decision = helperDecision(input, await hooks.decideAnswered(StartDecide, input));
      if (decision === 'unanswered') throw noHelperAdmission();
      return decision;
    },
    // Bounds Runtimes' answers below on the kernel clock (RUNTIME_START_DEADLINE_MS).
    after: (delayMs, fire) => kernel.clock.after(milliseconds(delayMs), fire),
    // Which harness and login a runtime starts with: Runtimes alone answers. With no Runtimes a start that names a
    // runtime is refused here, never launched signed out.
    runtimeStart: async runtime => {
      const found = hooks.provider(RuntimeStart, RUNTIME_START_KEY);
      return found === 'unavailable'
        ? {
            ok: false,
            sentence: `runtime ${runtime} cannot be started: the Runtimes plugin is not running, so its login cannot be found`,
          }
        : await found.resolve(runtime);
    },
    // The machine's default runtime, for a start that chose nothing: Runtimes alone answers; with no provider there is none.
    defaultRuntime: async () => {
      const found = hooks.provider(RuntimeStart, RUNTIME_START_KEY);
      return found === 'unavailable' ? undefined : await found.defaultRuntime?.();
    },
    // Whether a login named with no runtime may be spent: Runtimes alone answers, the same check a runtime's login passes.
    loginStart: async login => {
      const found = hooks.provider(RuntimeStart, RUNTIME_START_KEY);
      return found === 'unavailable'
        ? {
            ok: false,
            sentence: `login ${login} cannot be started: the Runtimes plugin is not running, so it cannot be checked`,
          }
        : await found.login(login);
    },
    launchParts: () => hooks.contributions(LaunchParts).map(contribution => contribution.item),
    daemonPath: () => kernel.hostFacts.launchGuard().searchPath,
    // The kind that HOLDS the login answers (`LoginKind.holds`): no kind trial, no caught throw. Each failure is a
    // fixed sentence; a Logins error is never quoted, because it can sit beside a credential.
    loginEnv: async (login, harness) => {
      const kind = loginKindOf(login);
      if (!kind.ok) return kind;
      return await answered(login, async () => await kind.value.env(login, harness));
    },
    // What Ferretry sets so the harness is signed in (`LoginKind.launchEnvironment`); a kind with none adds none.
    loginLaunchEnv: async (login, harness) => {
      const kind = loginKindOf(login);
      if (!kind.ok) return kind;
      const launch = kind.value.launchEnvironment;
      if (launch === undefined) return ok({});
      try {
        return await launch.call(kind.value, login, harness);
      } catch {
        return err(`the login ${login} could not be read, so the ferret was not started`);
      }
    },
    // The sign-in FILE a login hands its harness (`LoginKind.credential`), through the SAME kind resolver; a kind with none
    // answers `none`, and a hook that throws is `unavailable` with a fixed sentence (a Logins error is never quoted).
    loginCredential: async (login, harness) => {
      const kind = loginKindOf(login);
      if (!kind.ok) return { kind: 'unavailable', sentence: kind.error };
      const credential = kind.value.credential;
      if (credential === undefined) return { kind: 'none' };
      try {
        return await credential.call(kind.value, login, harness);
      } catch {
        return {
          kind: 'unavailable',
          sentence: `the login ${login} could not be checked, so the ferret was not started`,
        };
      }
    },
    openingAttachments: () => {
      const found = hooks.provider(OpeningAttachments, OPENING_ATTACHMENTS_KEY);
      return found === 'unavailable' ? undefined : found;
    },
    sitrepSources: () => hooks.contributions(SitrepLines).map(contribution => contribution.item),
    instructions: () => kernel.snapshot.current().instructions,
    folder: path => {
      if (!path.startsWith('/')) return err('the folder must be an absolute path');
      return ok(path as FencedPath);
    },
    // The launch folder's identity, captured where it is first checked and re-verified as the last step before the
    // harness starts (the kernel's bound directory).
    bindFolder: async path => {
      const bound = await kernel.paths.bindDirectory(path);
      if (!bound.ok) return err(bound.error.message);
      return ok({
        insideStateHome: bound.value.insideStateHome,
        realPath: bound.value.realPath,
        verify: async () => {
          const held = await bound.value.verify();
          return held.ok ? ok(undefined) : err(held.error.message);
        },
      });
    },
    // The folder the ferret will really work in, judged by the kernel's identity fence (a work folder or a link swapped
    // in after the route's check lands here).
    stateHomeHolding: async path => await kernel.paths.stateHomeHolding(path),
    delivered: ferret => late.wakeTurnWatch?.(ferret),
    changed: payload => {
      followStatus(payload.ferret, payload.state, 'lifecycle');
      if (payload.state === 'stopped') {
        transcripts.forget(payload.ferret);
        removeEnvironment(payload.ferret);
      }
      hooks.observe(FerretChanged, payload);
    },
    stopping: ferret => {
      hooks.observe(FerretStopping, { ferret });
    },
    lastSnapshot: async (ferret, runner, handle, deadPane) =>
      await lastSnapshots.capture(ferret, runner, handle, deadPane),
    started: payload => {
      hooks.observe(FerretStarted, payload);
    },
    saveDetails: async (ferret, details) => await kernel.state.write(FerretDetailsFile, details, ferret),
    // A stopped ferret holds no declared wait; the credit it banked stays.
    endWait: async ferret => {
      if (registry.waitingOf(ferret) === undefined) return;
      const { waiting: _ended, ...kept } = await parkedFile(ferret);
      await kernel.state.write(FerretWaitFiles, kept, ferret);
      registry.putWaiting(ferret, undefined);
    },
    history: appendHistory,
    limits: () => kernel.config.file(LimitsConfigFile),
    pinnedAt: async () => await agentPins.pinnedAt(),
    // `signal done` writes the summary (Packs' result and Clean up read it); a ferret that has not finished has none.
    summaryText: async ferret => {
      const read = await kernel.state.read(FerretSummaryFiles, ferret);
      return read.ok && read.value !== undefined ? new TextDecoder().decode(read.value) : undefined;
    },
    // The ferret's own `work` root decides: the folder must lie inside what the registry holds for THAT ferret, outside
    // the daemon's fence, and its links are resolved before the check. A refusal answers no folder (fails closed).
    realPath: async (ferret, folder) => {
      const root = kernel.roots.root('work', { ferret });
      const checked = root.resolve(folder);
      return checked.ok ? await root.realPath(checked.value) : undefined;
    },
    // The registry the worktrees module keeps (built below); read only, through its own lifecycle chain.
    managedWorktrees: async () => await lateOf(late.worktrees, 'worktrees').service.records(),
    // Bound below, once the moves are built (the moves resume through this very service).
    move: async (ferret, runtime, options) =>
      await lateOf(late.moves, 'moves').move.move(ferret, {
        agent: runtime,
        ...(options.model === undefined ? {} : { model: options.model }),
        allowContextDowngrade: options.allowContextDowngrade ?? false,
        forceInflight: options.forceInflight ?? false,
        ...(options.conversation === undefined ? {} : { conversation: options.conversation }),
        ...(options.note === undefined ? {} : { note: options.note }),
        ...(options.actor === undefined ? {} : { actor: options.actor }),
        ...(options.movedBy === undefined ? {} : { movedBy: options.movedBy }),
        origin: options.origin,
      }),
    // What the pane is asking (`FerretsApi.prompt`, U4): the turn watch's record, masked again on the way out.
    promptState: async ferret => {
      const state = SessionStateSchema.safeParse(
        await sessionStore.readState(ferret as unknown as SessionId).catch(() => undefined),
      );
      if (!state.success) return {};
      return await kernel.redaction.read(scope => promptOf(state.data, text => scope.text(text)));
    },
    // The stored last screen (`FerretsApi.lastSnapshot`): masked again with the Vault's values now; no frame on any failure.
    storedLastSnapshot: async ferret => await lastSnapshotReading.read(ferret),
    vault: needs.vault,
    asks: needs.asks,
    leases: conversationLeases,
  } satisfies FerretsPorts & Required<Pick<FerretsPorts, 'serial' | 'cutOffMark'>>;
  const service = new FerretsService(registry, tokens, servicePorts);

  // The transcript, through the harness that wrote it (U5): the proof of WHICH file is a ferret's is the harness's, so
  // Ferrets opens no transcript path. The turn fold and both stream sources read it here.
  const transcripts = new HarnessTranscript(
    ferret => {
      const key = registry.get(ferret)?.harness;
      const found = key === undefined ? 'unavailable' : hooks.provider(Harnesses, key);
      return found === 'unavailable' ? undefined : found;
    },
    ferret => registry.get(ferret)?.harness,
  );

  /**
   * The model a ferret is really running (today's `displayModel`): what the harness last reported, then its configured
   * model, then the wrapper's hint. A ferret whose config cannot be read falls back to the model it was started with.
   */
  const displayModelOf = async (ferret: FerretId): Promise<string | undefined> => {
    const summary = registry.summary(ferret);
    if (summary === undefined) return undefined;
    const id = ferret as unknown as SessionId;
    const config = SessionConfigSchema.safeParse(await sessionStore.readConfig(id).catch(() => undefined));
    const state = SessionStateSchema.safeParse(await sessionStore.readState(id).catch(() => undefined));
    return displayModel(
      config.success ? config.data : { model: summary.model, modelHint: '' },
      state.success ? state.data : {},
    );
  };

  /**
   * What a ferret's own documents say that the insights index needs (today's analytics candidate source): the SELECTED
   * model and the send counter, from the same two documents `displayModelOf` reads. A ferret whose pair does not parse
   * says nothing, so an index row is never assembled from a document the schema rejected.
   */
  const ingestEvidenceOf = async (ferret: FerretId): Promise<FerretIngestEvidence | undefined> => {
    if (registry.summary(ferret) === undefined) return undefined;
    const id = ferret as unknown as SessionId;
    const config = SessionConfigSchema.safeParse(await sessionStore.readConfig(id).catch(() => undefined));
    const state = SessionStateSchema.safeParse(await sessionStore.readState(id).catch(() => undefined));
    return config.success && state.success ? ingestEvidence(config.data, state.data) : undefined;
  };

  /** The ferret an id or a name addresses; a name two ferrets hold on one footing addresses none. */
  const resolveFerret = (reference: string): FerretId | undefined => {
    const resolution = resolveAgentAddress(
      reference,
      registry.list().map(ferret => ({ id: ferret.id, name: ferret.name, status: ferret.state })),
    );
    return resolution.kind === 'session' ? (resolution.id as FerretId) : undefined;
  };

  /** The ferret a path names: an exact id, or a name (a live holder wins; two on one footing are refused). */
  const pathFerret = async (call: CallContext): Promise<FerretId> => {
    await ready();
    const raw = decodeParameter(call.params.get('ferretId') ?? '');
    if (raw === undefined || raw === '')
      throw new ApiError(400, 'the ferret id in the path is not usable', 'invalid_session_id');
    const resolution = resolveAgentAddress(
      raw,
      registry.list().map(ferret => ({ id: ferret.id, name: ferret.name, status: ferret.state })),
    );
    if (resolution.kind === 'session') return resolution.id as FerretId;
    if (resolution.kind === 'ambiguous')
      throw new ApiError(409, ambiguousAgentAddressMessage(resolution.name, resolution.candidates), 'ambiguous_name');
    throw new ApiError(404, `no ferret ${raw}`, 'not-found');
  };

  /**
   * Whether the folder a ferret is started in lies inside the state home, by BOTH of the kernel's fences: the name-and-link
   * fence (`stateHomeHolding`: as named, on every link hop, by real path and by identity up to `/`) and the bound directory
   * (`bindDirectory`: the identity the launch will hold, the same fence the owner roots use). Either one holding refuses.
   * A folder that is not a directory is not inside anything by the bound directory (the start refuses it as a folder); a
   * fence the kernel cannot compute, from either, fails closed for an agent with today's 503 `state_home_unresolved`, and
   * never with a lexical stand-in or a fallback to "not inside". The file browser needs none: the pin a work root hands out
   * judges every walk beneath it against the kernel's fence itself (S40, S47).
   */
  const stateHomeReach: StateHomeLaunchReach = {
    holding: async path => {
      const named = await kernel.paths.stateHomeHolding(path);
      if (named !== undefined) return named;
      const bound = await kernel.paths.bindDirectory(path);
      if (!bound.ok) {
        if (bound.error.reason === 'not_a_directory' || bound.error.reason === 'not_absolute') return undefined;
        throw new Error(bound.error.message);
      }
      return bound.value.insideStateHome ? bound.value.realPath : undefined;
    },
  };

  /**
   * The folders a governed device may start a ferret in as an ordinary act (v4 `knownLaunchRoots`): the projects the
   * owner registered, then the managed worktree root. With Projects off the list is empty, so a governed start is
   * terminal access (`terminal.use`): narrower, never wider. A throw from Projects is NOT an empty list: it propagates.
   */
  const knownLaunchRoots = async (): Promise<readonly string[]> => {
    const found = hooks.provider(LaunchRoots, LAUNCH_ROOTS_KEY);
    const projects = found === 'unavailable' ? [] : await found.roots();
    const managedRoot = lateOf(late.worktrees, 'worktrees').managedRoot;
    return managedRoot === undefined ? projects : [...projects, managedRoot];
  };

  /** S47: an agent reaches only its own ferret and its helpers'; a person is unaffected. */
  const agentMayReach = (call: CallContext, target: FerretId): void => {
    if (!callerIsAgent(call)) return;
    const own = callerFerret(call);
    if (own === undefined)
      throw new ApiError(
        403,
        'an agent reads only its own ferret’s files, and this request names no ferret of its own',
        NOT_OWN_FERRET_CODE,
      );
    if (!registry.mayTouch(own, target))
      throw new ApiError(
        403,
        `an agent reads only its own ferret’s files and its helpers’, and ${target} is neither`,
        NOT_OWN_FERRET_CODE,
      );
  };

  /** A ferret may stop, resume or rename itself and its helpers; a person any ferret. */
  const mayAct = (call: CallContext, target: FerretId): void => {
    const own = callerFerret(call);
    if (own !== undefined && !registry.mayTouch(own, target))
      throw new ApiError(403, `a ferret acts only on itself and its helpers, and ${target} is neither`, 'forbidden');
  };

  const sessionGit = new RunnerSessionGit(
    new KernelGitRunner({
      // A string folder is one this module already fenced (a scratch folder); a held directory is the kernel's pin.
      runBytes: async (program, args, { cwd, ...rest }) =>
        await kernel.spawn.runBytes(program, args, {
          ...rest,
          ...(cwd === undefined ? {} : { cwd: cwd as FencedPath | PinnedWorkingDirectory }),
        }),
    }),
    new KernelDiffScratch(kernel.scratch),
  );
  const sessionFilesystemOf = (ferret: string): SessionFilesystem =>
    new SessionFilesystem(
      new KernelSessionRootPinner(kernel.roots.root('work', { ferret: ferret as FerretId })),
      sessionGit,
      () => kernel.clock.nowMs(),
    );

  const parseJson = (text: string): unknown => {
    if (text.trim() === '') return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new ApiError(400, 'the request body is not JSON', 'invalid_json');
    }
  };
  const body = async (call: CallContext): Promise<unknown> => parseJson(await call.request.text());

  // What a launch now would tell a RUNNING ferret, against what its own launch told it (U6): the same entries a launch
  // narrows by role and harness, compared by fingerprint. Nothing recorded, a stopped ferret or a damaged record answers
  // nothing: a restart is only ever taken on proof.
  const outdatedFor = async (ferret: FerretId): Promise<readonly LaunchInstructionSectionId[]> => {
    const record = registry.get(ferret);
    if (record === undefined || record.state === 'stopped') return [];
    const told = await kernel.state.read(FerretLaunchSectionsFiles, ferret);
    if (!told.ok || told.value === undefined) return [];
    return outdatedSectionIds(
      told.value.sections,
      sectionDigests(applicableInstructions(kernel.snapshot.current().instructions, record)),
    );
  };
  // The same answer as a MARK on the list and the view (today's `withOutdated`, 5 s): advice, never a restart decision.
  const outdatedMarks = outdatedMark({ outdated: outdatedFor, nowMs: () => kernel.clock.nowMs(), ttlMs: 5_000 });
  /** Whether the archive took this ferret out of the live set (a read: it writes nothing and revives nothing). */
  const isArchived = (ferret: string): boolean => sessionStore.isArchived(ferret as unknown as SessionId);
  /** Brings an archived ferret back into the live set; nothing for one that is live. */
  const reviveArchived = async (ferret: string): Promise<void> => {
    if (!isArchived(ferret)) return;
    await sessionStore.retainSession(ferret as unknown as SessionId);
  };

  /** A wake-up for views (the ferret list re-reads): a change the registry does not carry (a pin) says so. */
  const publishChanged = (ferret: string): void => {
    generation += 1;
    kernel.events.publish(FerretsChanged, { ferret, generation });
  };

  // One composition, handed to every feature in `./features/*.feature.ts` (listed by the generator into
  // `./generated/features.ts`): each adds its own routes, sockets, jobs and port members. This file keeps the stores, the
  // service and the shared guards; a new feature adds a file there and edits nothing here.
  const context: FerretsContext = {
    daemon: ctx,
    kernel,
    hooks,
    needs,
    log,
    registry,
    service,
    sessionStore,
    sessionFiles,
    launch,
    ready,
    storeLoaded,
    archiveRead,
    heldClaims,
    appendHistory,
    eventSource,
    agentPins,
    pinClock,
    transcripts,
    followStatus,
    removeEnvironment,
    parkedFile,
    sessionFilesystemOf,
    sessionGit,
    displayModelOf,
    ingestEvidenceOf,
    outdated: { sections: outdatedFor, marks: outdatedMarks },
    resolveFerret,
    pathFerret,
    mayAct,
    agentMayReach,
    parseJson,
    body,
    stateHomeReach,
    knownLaunchRoots,
    publishChanged,
    isArchived,
    reviveArchived,
    late,
  };
  const served = registerFeatures(features, context);
  // No launch runs on a half-filled list: a feature that registers a store after this throws at boot.
  launch.seal();

  return {
    provides: {
      ferrets: perNeeder(needer => ({
        ...ferretsPort(service, needer.id),
        // What the features add to the port (a read each owns, `lastAutoResume` among them).
        ...served.port,
        displayModel: displayModelOf,
        // One folder of a ferret's tree for the composer's `@` menu, through the file browser's own service and fence.
        listFolder: folderLister({
          folderOf: id => registry.get(id)?.folder,
          filesystem: sessionFilesystemOf,
          mayTouch: (caller, target) => registry.mayTouch(caller, target),
        }),
        ingestEvidence: ingestEvidenceOf,
        // What live panes prove about their logins, read from the session documents each time and kept nowhere.
        paneLimits: async () =>
          await livePaneLimits({
            sessions: () => sessionStore.listSessions(),
            readState: async id => await sessionStore.readState(id as unknown as SessionId),
            record: id => registry.get(id as FerretId),
            nowMs: () => kernel.clock.nowMs(),
          }),
      })),
      workFolders,
      agentControl: agentControlReader(ferret => service.agentControl(ferret)),
    },
    tools: {
      // Today's `instructions`: answered for the ferret the session credential names, from what ITS launch told it.
      instructions: async call =>
        await instructionsAnswer(callerFerret(call), id => launchEnvironment.read(id), kernel.identity.binaries.client),
    },
    hooks: {
      // Lineage for the agenda: who exists and who started whom (Asks refuses a helper's item on it).
      'agenda.context:ferrets': ferretsAgendaContext(registry, ready),
      'bearers:ferret': {
        ferretFor: (digest: BearerDigest) => {
          const ferret = tokens.ferretFor(digest);
          const record = ferret === undefined ? undefined : registry.get(ferret);
          // A failed token-store write may leave an old live digest on disk. A stopped (or absent) ferret still
          // authenticates nobody after restart, even when that stale digest survived process-failure cleanup.
          return record === undefined || record.state === 'stopped' ? undefined : ferret;
        },
        generation: () => tokens.generation(),
      },
    },
    sockets: served.sockets as NonNullable<DaemonHalf<typeof manifest>['sockets']>,
    routes: served.routes as NonNullable<DaemonHalf<typeof manifest>['routes']>,
  };
}

/** Ferrets' daemon half (§2.2). */
export default implementDaemon(manifest, { build });
