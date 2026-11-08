import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { type BearerDigest, ferretOf } from '@ferretry/core-gate/contract';
import {
  ApiError,
  type ApiResponse,
  type CallContext,
  decodeParameter,
  type FencedPath,
  headerValue,
  jsonResponse,
  type PinnedWorkingDirectory,
  queryValue,
} from '@ferretry/kernel/contract';
import { type DaemonContext, type DaemonHalf, implementDaemon } from '@ferretry/kernel/manifest';
import { err, milliseconds, ok } from '@ferretry/std';
import {
  type FerretId,
  FerretChanged,
  FerretStopping,
  FerretStarted,
  FerretFiles,
  RestartsFile,
  FerretHistoryFiles,
  type FerretRecord,
  type FerretState,
  FerretsChanged,
  FerretTokensFile,
  type HarnessKey,
  LimitsConfigFile,
  ArchiveConfigFile,
  ArchiveKeeps,
  FerretLaunchSectionsFiles,
  Harnesses,
  LaunchParts,
  Runners,
  SitrepLines,
  SubtreeViewSchema,
  StartDecide,
  AutoResumeDecide,
  AgentPinsFile,
  FerretDetailsFile,
  FerretPinsFile,
  lookupStartRequest,
  StartRequestsFile,
  withStartRequest,
  RestartQueueEntrySchema,
  FerretLaunchEnvironmentFiles,
  FerretSummaryFiles,
  FerretWaitFiles,
} from '../contract/index.ts';
import { SubtreeService } from './lib/session/pack/subtree.ts';
import manifest from '../manifest.ts';
import { ConditionalFleetList } from './lib/fleet-list/conditional.ts';
import { outdatedMark } from './lib/fleet-list/outdated-mark.ts';
import { FerretsService, RENAME_HTTP } from './lib/ferrets/service.ts';
import { helperDecision, noHelperAdmission } from './lib/ferrets/helper-admission.ts';
import { boundedReason } from './lib/ferrets/auto-resume.ts';
import { parseRenameBody, parseResumeBody, parseStartBody, parseStopBody } from './lib/ferrets/wire.ts';
import { createSessionEvent, encodeSessionEvent, parseSessionEvent } from './lib/storage/journal.ts';
import { type SessionId, tryParseSessionId } from './lib/session-id.ts';
import { DEFAULT_CALLSIGN_POOL, NameAllocator, SystemCallsignIssuer, suggestCallsigns } from './lib/names/index.ts';
import type { NameClaim } from './lib/names/types.ts';
import { archivedNameClaims } from './lib/names/session-names.ts';
import { LedgerNameClaimStore, stateClaimLedger } from './adapters/names/name-claim-store.ts';
import { StateCallsignCounters } from './adapters/names/state-callsign-counters.ts';
import { ambiguousAgentAddressMessage, resolveAgentAddress } from './lib/protocol/agent-address.ts';
import { FerretRegistry } from './lib/registry/registry.ts';
import { FerretTokenDirectory, type TokenEntry } from './lib/tokens/tokens.ts';
import { instructionsAnswer } from './lib/agent-control/instructions.ts';
import { LaunchEnvironmentStore, switchesOfRecord } from './lib/agent-control/launch-environment.ts';
import { agentControlReader } from './lib/agent-control/reader.ts';
import { RegistryWorkFolders } from './lib/work-folders/work-folders.ts';
import { buildWorktrees } from './modules/worktrees.ts';
import { FY_REQUEST_ID_HEADER } from './lib/protocol/headers.ts';
import { WARDEN_LABEL } from './lib/session/peers/warden-lifecycle.ts';
import { sessionFilesystemRoutes } from './lib/runtime/mounts/session-filesystem.ts';
import { AGENT_READ_FENCE, SessionFilesystem } from './lib/session/filesystem/index.ts';
import { KernelGitRunner } from './adapters/git/runner.ts';
import { KernelDiffScratch, KernelSessionRootPinner, RunnerSessionGit } from './adapters/session/filesystem/index.ts';
import { StateAgentPinRepository } from './adapters/agent-pins/index.ts';
import { RegistryPinSessionDirectory, StatePinRepository } from './adapters/pins/index.ts';
import { KeyedSerialExecutor } from './adapters/storage/keyed-serial-executor.ts';
import { type StateHomeLaunchReach, stateHomeLaunchRefusal } from './lib/route-security/state-home.ts';
import { terminalLaunchRefusal } from './lib/route-security/launch.ts';
import { confirmRestore } from './lib/route-security/restore.ts';
import { AgentPinService, AgentPinSubsystem, withPinned } from './lib/agent-pins/index.ts';
import { PinService } from './lib/pins/index.ts';
import { pinRoutes } from './lib/runtime/mounts/pins.ts';
import { sessionPinRoutes } from './lib/runtime/mounts/session-pin.ts';
import { sessionArchiveRoutes } from './lib/runtime/mounts/session-archive.ts';
import { ARCHIVE_PASS_JOB, ARCHIVE_TICK_MS, buildArchive, hiddenFromLiveList } from './modules/archive.ts';
import { sessionRestartRoutes } from './lib/runtime/mounts/session-restart.ts';
import { FerretRestarts, restartService } from './lib/ferrets/restarts.ts';
import { sessionSignalRoutes } from './lib/runtime/mounts/session-signal.ts';
import { FerretSignals } from './lib/ferrets/signals.ts';
import { SessionSignalService } from './lib/session/signal/service.ts';
import {
  FerretSignalArtifacts,
  type FerretSignalHost,
  FerretSignalRepository,
  FerretSignalTerminal,
} from './adapters/session/signal/ferret-signal.ts';
import { DaemonStorage } from './adapters/storage/session-storage.ts';
import { SessionFiles } from './modules/session-files.ts';
import { buildMoves, MOVE_ROUTE_KEYS } from './moves.ts';
import { movesDeps } from './moves-deps.ts';
import { fleetEventsAccept, followableFerret, HistoryEventSource } from './modules/fleet-events.ts';
import { ferretsPort } from './lib/ferrets/port.ts';
import { ferretsMoveResume, movedTarget } from './lib/ferrets/move-resume.ts';
import type { ResumeActor } from './lib/session/resume/types.ts';
import { SessionStateSchema } from './lib/protocol/session.ts';
import { promptOf } from './lib/ferrets/prompt.ts';
import { buildTurnWatch, turnWatchFailureFields } from './modules/turn-watch.ts';
import { buildLiveEvents } from './modules/live-events.ts';
import { FileLastSnapshotStore } from './adapters/session/snapshot/file-last-snapshot-store.ts';
import { LastSnapshotCapture } from './lib/session/snapshot/capture.ts';
import { HarnessTranscript } from './adapters/session/live/harness-transcript.ts';
import { applicableInstructions, outdatedSectionIds, sectionDigests } from './lib/ferrets/launch-sections.ts';
import type { LaunchInstructionSectionId } from './lib/protocol/session.ts';
import { lifecycleStatus, withLifecycleStatus } from './lib/ferrets/session-document.ts';
import { AUTO_RESUME_JOB, buildAutoResume } from './modules/auto-resume.ts';
import { relaunchSettings } from './modules/relaunch-settings.ts';

/** The code an agent asking for a ferret that is not its own, or its helper's, is refused with (today's). */
export const NOT_OWN_FERRET_CODE = 'not_own_session';

/** The job that arms the turn watch once the daemon serves (today's `activities.run('turn watcher', …)`, J-0001). */
export const TURN_WATCH_JOB = 'ferrets.turn-watch';

/**
 * The ferret behind a call, from Gate's standing (`ferretOf`, today's `agentSessionOf`): a ferret's own token, or the
 * admin token with a ferret named in `x-ferretry-session-id` (the call's actor is then that ferret's). `undefined` for a
 * person (the admin token with no ferret behind it, a device) and for the Warden, which acts as no ferret.
 */
export function callerFerret(call: CallContext): FerretId | undefined {
  return ferretOf(call);
}

/** Whether the caller is an agent (a ferret's token, the warden, or the admin token with a ferret behind it). */
function callerIsAgent(call: CallContext): boolean {
  const credential = call.credential;
  if (credential === undefined) return false;
  if (credential.tokenClass === 'ferret' || credential.tokenClass === 'warden') return true;
  if (credential.tokenClass === 'device') return false;
  return call.actor !== 'admin-ui' && call.actor !== 'admin-cli';
}

/**
 * Who asked for a resume, for the author recorded beside its turn document (today's `resumeTurnAuthor` input):
 * ATTRIBUTION only, never authority, which the route has already decided. The warden is the Warden; a ferret's token,
 * or the admin token with a ferret behind it, is a peer ferret; a device and the admin UI or CLI are the owner.
 */
function resumeActorOf(call: CallContext): ResumeActor {
  const credential = call.credential;
  if (credential?.tokenClass === 'warden') return 'warden';
  if (credential?.tokenClass === 'ferret' || callerFerret(call) !== undefined) return 'peer';
  if (credential?.tokenClass === 'device') return 'device';
  if (call.actor === 'admin-cli' || call.actor === 'admin-ui') return call.actor;
  return 'unknown';
}

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
  const fleetList = new ConditionalFleetList();

  // Load what is held. Sync answers (`mayTouch`, `bearers:ferret`, `WorkFolders`) see nothing until this lands,
  // which fails closed: an unknown ferret is refused, an unknown digest is no ferret.
  const loaded = (async () => {
    for (const name of await kernel.state.list(FerretFiles)) {
      const read = await kernel.state.read(FerretFiles, name);
      if (read.ok && read.value !== undefined) registry.put(read.value);
      else if (!read.ok) log.warn('a ferret record could not be read', { file: read.error.file });
      if (!read.ok || read.value === undefined) continue;
      // Its start options and title, kept beside the record so a list or a read stays memory-only.
      const details = await kernel.state.read(FerretDetailsFile, name);
      if (details.ok && details.value !== undefined) registry.putDetails(read.value.id, details.value);
      else if (!details.ok) log.warn('a ferret details file could not be read', { file: details.error.file });
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

  /**
   * Today's journal append (`storage/session-storage.ts` `append`) without its index: the next sequence after the
   * last readable event. One chain per ferret; a journal that cannot be read to its end is not appended to.
   */
  // The journal stream's source: each ferret's history.jsonl, and the append edge below.
  const eventSource = new HistoryEventSource(kernel.state, () => registry.list().map(ferret => ferret.id));
  const historyQueue = new KeyedSerialExecutor();
  const appendHistory = async (ferret: FerretId, type: string, data: Readonly<Record<string, unknown>>) =>
    await historyQueue
      .run(ferret, async () => {
        let last = 0;
        for await (const line of kernel.state.lines(FerretHistoryFiles, ferret)) {
          const event = parseSessionEvent(line, ferret as unknown as SessionId);
          if (event !== undefined) last = Math.max(last, event.sequence);
        }
        const event = createSessionEvent(ferret as unknown as SessionId, last, kernel.clock.now(), type, data);
        await kernel.state.append(FerretHistoryFiles, encodeSessionEvent(event), ferret);
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

  const sessionFiles = new SessionFiles({
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
  });
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
  // GAP(ports-pending: Ferrets): with no hypermedia switch set, the mode default the pane is handed is not recorded.
  // GAP(ports-pending: Lessons): no `launch.parts` contribution of FY_LEARNING_PASSIVE yet.
  // Until each lands its section is not recorded, and `instructions` reads it as off: no stand-in. Each is one line in
  // ports-pending.json under its owner (ferrets, lessons).
  const launchEnvironment = new LaunchEnvironmentStore(
    {
      read: async ferret => {
        const read = await kernel.state.read(FerretLaunchEnvironmentFiles, ferret);
        return read.ok ? (read.value ?? {}) : {};
      },
      write: async (ferret, environment) => await kernel.state.write(FerretLaunchEnvironmentFiles, environment, ferret),
    },
    async ferret => switchesOfRecord(registry.get(ferret)),
  );

  // The state document's LIFECYCLE status follows the registry (U4): made `starting`, it moves to `running` once the
  // launch settles and to `stopped` at a stop, as today's lifecycle moved it (`lifecycleStatus`). The turn watch's writer
  // re-reads that status under the lock, so a document left `starting` would never be given a turn. One lane per
  // ferret, in the order the registry changed; a ferret with no document yet is left alone.
  const statusLane = new KeyedSerialExecutor();
  const followStatus = (ferret: FerretId, state: FerretState): void => {
    const id = tryParseSessionId(ferret);
    if (id === undefined) return;
    void statusLane
      .run(ferret, async () => {
        if ((await sessionStore.readState(id).catch(() => undefined)) === undefined) return;
        await sessionStore.updateState(id, raw => {
          const current = SessionStateSchema.safeParse(raw);
          const next = current.success ? lifecycleStatus(current.data.status, state) : undefined;
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

  // The ferret's last screen, kept as it stops (F-0326): one `Runner.look` (an act on the pane, masked by the runner),
  // masked again here, written 0600 to its own folder on the sessions root, bounded by the kernel clock.
  const lastSnapshots = new LastSnapshotCapture({
    store: id => new FileLastSnapshotStore(sessionFiles.root(id), id),
    redaction: kernel.redaction,
    sleep: async (delay, signal) => await kernel.clock.sleep(delay, signal),
    log,
  });

  // Bound once the turn watch is built below: a delivery into a ferret's pane brings its next look forward.
  let wakeTurnWatch: ((ferret: FerretId) => void) | undefined;
  // Bound once the harness transcript is built below: a stopped ferret's remembered transcript and tail are dropped.
  let forgetTranscript: ((ferret: FerretId) => void) | undefined;
  const service = new FerretsService(registry, tokens, {
    launchEnvironment,
    launchSections: {
      write: async (ferret, sections) => await kernel.state.write(FerretLaunchSectionsFiles, { sections }, ferret),
      forget: async ferret => await kernel.state.remove(FerretLaunchSectionsFiles, ferret),
    },
    ready,
    session: sessionFiles.port,
    claims,
    systemCallsign: async prefix => await systemCallsigns.next(prefix),
    now: () => kernel.clock.now(),
    newId: () => mintId(kernel.clock.nowMs()),
    newName: taken =>
      DEFAULT_CALLSIGN_POOL.find(candidate => !taken(candidate)) ?? `ferret-${randomBytes(3).toString('hex')}`,
    save: async (record: FerretRecord) => await kernel.state.write(FerretFiles, record, record.id),
    saveTokens: async entries =>
      await kernel.state.write(FerretTokensFile, {
        format: 1,
        tokens: entries.map(entry => ({ ...entry })) as never,
      }),
    harness: key => {
      const found = hooks.provider(Harnesses, key);
      return found === 'unavailable' ? undefined : found;
    },
    harnessKeys: () => [...hooks.providers(Harnesses).keys()] as HarnessKey[],
    runner: () => {
      const found = hooks.provider(Runners, 'tmux');
      return found === 'unavailable' ? undefined : found;
    },
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
    launchParts: () => hooks.contributions(LaunchParts).map(contribution => contribution.item),
    sitrepSources: () => hooks.contributions(SitrepLines).map(contribution => contribution.item),
    instructions: () => kernel.snapshot.current().instructions,
    folder: path => {
      if (!path.startsWith('/')) return err('the folder must be an absolute path');
      return ok(path as FencedPath);
    },
    delivered: ferret => wakeTurnWatch?.(ferret),
    changed: payload => {
      followStatus(payload.ferret, payload.state);
      if (payload.state === 'stopped') forgetTranscript?.(payload.ferret);
      hooks.observe(FerretChanged, payload);
    },
    stopping: ferret => {
      hooks.observe(FerretStopping, { ferret });
    },
    lastSnapshot: async (ferret, runner, handle) => await lastSnapshots.capture(ferret, runner, handle),
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
    managedWorktrees: async () => await worktrees.service.records(),
    // Bound below, once the moves are built (the moves resume through this very service).
    move: async (ferret, runtime, options) =>
      await moves.move.move(ferret, {
        agent: runtime,
        ...(options.model === undefined ? {} : { model: options.model }),
        allowContextDowngrade: options.allowContextDowngrade ?? false,
        forceInflight: options.forceInflight ?? false,
        ...(options.conversation === undefined ? {} : { conversation: options.conversation }),
        ...(options.note === undefined ? {} : { note: options.note }),
        ...(options.actor === undefined ? {} : { actor: options.actor }),
        ...(options.movedBy === undefined ? {} : { movedBy: options.movedBy }),
      }),
    // What the pane is asking (`FerretsApi.prompt`, U4): the turn watch's record, masked again on the way out.
    promptState: async ferret => {
      const state = SessionStateSchema.safeParse(
        await sessionStore.readState(ferret as unknown as SessionId).catch(() => undefined),
      );
      if (!state.success) return {};
      return await kernel.redaction.read(scope => promptOf(state.data, text => scope.text(text)));
    },
    vault: needs.vault,
    asks: needs.asks,
  });

  // The turn watch (U4, RULING #44): the session observer's turn part on the main thread, every live ferret's pane looked
  // at through `Runner.look` at today's 2 s tick (a quiet pane backing off to 10 s), one pane per turn of the loop.
  // Armed once the daemon serves (today's `observer.arm()` after the first monitor tick), closed when it stops.
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
  forgetTranscript = ferret => transcripts.forget(ferret);
  const turnWatch = buildTurnWatch({
    storage: sessionStore,
    tail: transcripts.tail,
    record: ferret => registry.get(ferret),
    runner: () => {
      const found = hooks.provider(Runners, 'tmux');
      return found === 'unavailable' ? undefined : found;
    },
    turnObserved: async (ferret, turn) => await service.turnObserved(ferret, turn),
    clock: { now: () => kernel.clock.now() },
    every: (intervalMs, tick) => kernel.clock.every(milliseconds(intervalMs), tick),
    yieldToLoop: async () => await kernel.clock.sleep(milliseconds(0)),
    log,
  });
  wakeTurnWatch = turnWatch.wake;
  kernel.jobs.add({
    id: TURN_WATCH_JOB,
    schedule: { onceAfterStart: true },
    run: async () => {
      await ready();
      await storeLoaded.catch(() => undefined);
      // Once per arm, every held ferret's document is brought to its registry state: one left `starting` by a crash
      // between the registry's write and the status lane's (or written before U4) would otherwise never be given a
      // turn, and no registry change would come to repair it. The same lane and rule as every later edge.
      for (const record of registry.list()) followStatus(record.id, record.state);
      turnWatch.host.arm();
      kernel.lifecycle.onStop(async () => await turnWatch.host.close());
    },
  });

  // G24: the same bounded read as today's subtree API, masked whole before excerpts are cut.
  const subtree = new SubtreeService(registry, {
    nowMs: () => kernel.clock.nowMs(),
    lines: async ferret => (await service.sitrep(ferret))?.lines ?? [],
    redact: texts => kernel.redaction.read(scope => texts.map(text => scope.text(text))),
  });

  // Managed worktrees (today's worktrees module). The Git/disk IO is the kernel's spawn and root additions on
  // rebuild/port-kernel; until the host has them there is no managed root and every route says so.
  const worktrees = buildWorktrees({
    state: kernel.state,
    clock: kernel.clock,
    sessions: async () => {
      await ready();
      // A ferret standing in a folder, as today's session directory reported it: stopped ferrets are finished.
      return registry.list().map(ferret => ({
        id: ferret.id,
        cwd: ferret.folder,
        status: ferret.state === 'stopped' ? ('stopped' as const) : ('running' as const),
        ...(ferret.state === 'stopped' ? { finishedAt: ferret.stateAt } : {}),
      }));
    },
    terminalRoots: async () => undefined,
    newId: () => randomUUID(),
  });

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
   * The kernel gives a plugin no state-home identity or link-hop reach yet, so the launch refusal (the folder a ferret
   * is started in) fails closed for an agent with today's 503 `state_home_unresolved`, and never with a lexical
   * stand-in. The file browser needs none: the pin a work root hands out judges every walk beneath it against the
   * kernel's fence itself (S40, S47).
   */
  const stateHomeReach: StateHomeLaunchReach | undefined = undefined;

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

  // The file browser (today's session-filesystem mount) over the kernel: each ferret's `work` root pins its folder and
  // walks beneath it by descriptor and Git runs in the held object. For an AGENT the pin refuses (`denied`, 403) every
  // path inside the state home and every hard link, and the service asks the pin's name verdict wherever a name never
  // passes through the walk (Git's change list, a HEAD read, a badge); a PERSON is unfenced, as today (S47). The
  // service is stateless, so one is made for the ferret a request names.
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
  const fileBrowser = sessionFilesystemRoutes({
    filesystem: ferret =>
      new SessionFilesystem(
        new KernelSessionRootPinner(kernel.roots.root('work', { ferret: ferret as FerretId })),
        sessionGit,
        () => kernel.clock.nowMs(),
      ),
    redaction: kernel.redaction,
    reach: async call => {
      const id = await pathFerret(call);
      agentMayReach(call, id);
      const folder = registry.get(id)?.folder;
      if (folder === undefined) throw new ApiError(404, `no ferret ${id}`, 'not-found');
      // S47, today's `agentFence`: an agent reads only its own ferret's and its helpers' files (above), behind the
      // state-home fence; a person reads unfenced.
      return { id, cwd: folder, ...(callerIsAgent(call) ? { fence: AGENT_READ_FENCE } : {}) };
    },
  });

  const parseJson = (text: string): unknown => {
    if (text.trim() === '') return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new ApiError(400, 'the request body is not JSON', 'invalid_json');
    }
  };
  const body = async (call: CallContext): Promise<unknown> => parseJson(await call.request.text());

  // Moves and forks (ferrets-c): today's fork, handover and move modules, built once. The archive the session store
  // keeps is read before the first of their routes answers; the handover's reconcile loop is armed once the daemon
  // serves (today: beside the warden sweep) and disarmed when it stops.
  const moves = buildMoves(
    ctx,
    movesDeps(ctx, {
      storage: sessionStore,
      clientName: 'fy',
      environment: sessionFiles.environment,
      createLifecycle: sessionFiles.createLifecycle,
      // A move's relaunch is a resume of THIS service, so it goes through the ordinary launch (home, token, environment).
      resume: ferretsMoveResume(
        service,
        ferret => registry.get(ferret),
        async ferret => await movedTarget(async () => await sessionStore.readConfig(ferret as unknown as SessionId)),
      ),
      // The relaunch-settings read (W2-c, RULING #27 Q9): the ferret's own harness compares what it launched under with
      // its settings now; Ferrets reads no harness file. The caller check is `mayAct` below, as for every move route.
      launch: relaunchSettings({
        harnessOf: ferret => registry.get(ferret)?.harness,
        harness: key => {
          const found = hooks.provider(Harnesses, key);
          return found === 'unavailable' ? undefined : found;
        },
        after: (delayMs, fire) => kernel.clock.after(milliseconds(delayMs), fire),
      }),
    }),
  );
  // These routes fork, hand over, move or read the conversation of the ferret they name, so — like resume and stop — a
  // ferret may reach only itself and its helpers.
  const MOVE_ACTING_ROUTES: readonly string[] = [
    'POST /v1/ferrets/:ferretId/move',
    'POST /v1/ferrets/:ferretId/move/ask-to-stop-jobs',
    'POST /v1/ferrets/:ferretId/fork',
    'POST /v1/ferrets/:ferretId/handover',
    'GET /v1/ferrets/:ferretId/handover',
    'POST /v1/ferrets/:ferretId/handover/cancel',
    'GET /v1/ferrets/:ferretId/relaunch-settings',
    'POST /v1/ferrets/:ferretId/conversion-preview',
  ];
  const moveRoutes = Object.fromEntries(
    MOVE_ROUTE_KEYS.map(key => [
      key,
      async (call: CallContext) => {
        if (MOVE_ACTING_ROUTES.includes(key)) mayAct(call, await pathFerret(call));
        await storeLoaded;
        return await moves.routes[key](call);
      },
    ]),
  ) as typeof moves.routes;
  // Auto-resume after a host restart (W2-a, today's `createAutoResume` + `BootExitRecorder`): once the daemon serves, the
  // ferrets whose terminal the runner PROVES gone are settled `terminal_gone` and written to the ledger, then resumed
  // through the ordinary resume, staggered, two at a time, each only on Runtimes' OWN yes (RULING #27 Q5: no answer, no
  // resume, no spend). A person's stop, resume or archive in between wins (`expect`, judged under the ferret's queue).
  const autoResume = buildAutoResume({
    state: kernel.state,
    // The held records (with the runner handle the list view leaves out): the handle is what the settle compares.
    records: () =>
      registry.list().flatMap(ferret => {
        const held = registry.get(ferret.id);
        return held === undefined ? [] : [held];
      }),
    record: ferret => registry.get(ferret),
    status: async ferret => {
      const state = SessionStateSchema.safeParse(await sessionStore.readState(ferret as unknown as SessionId));
      return state.success ? state.data.status : undefined;
    },
    gone: async ferret => {
      const runner = hooks.provider(Runners, 'tmux');
      return runner !== 'unavailable' && runner.gone !== undefined && (await runner.gone(ferret)) === true;
    },
    settle: async (ferret, handle, exited) => await service.settleGone(ferret, handle, exited),
    decide: async input => await hooks.decideAnswered(AutoResumeDecide, input),
    // Why a resume was refused (a start.decide taker's sentence, a launch's message) is kept in the journal and the
    // summary, so it is bounded as Runtimes' own refusal is.
    resume: async (ferret, message, expect) => {
      const resumed = await service
        .resume(ferret, message, { actor: 'daemon', automatic: true, expect })
        .catch((error: unknown) => {
          throw new Error(boundedReason(error instanceof Error ? error.message : String(error)));
        });
      if (!resumed.ok) throw new Error(boundedReason(resumed.error.reason));
    },
    history: appendHistory,
    clock: { now: () => kernel.clock.now(), nowMs: () => kernel.clock.nowMs() },
    sleep: async delay => await kernel.clock.sleep(milliseconds(delay)),
    log,
  });
  kernel.jobs.add({
    id: AUTO_RESUME_JOB,
    schedule: { onceAfterStart: true },
    run: async () => {
      await ready();
      await storeLoaded.catch(() => undefined);
      await autoResume
        .run()
        .catch((error: unknown) =>
          log.warn('the auto-resume pass stopped early', { error: error instanceof Error ? error.name : 'unknown' }),
        );
    },
  });

  kernel.jobs.add({
    id: 'ferrets.handover-reconcile',
    schedule: { onceAfterStart: true },
    run: async () => {
      await storeLoaded;
      kernel.lifecycle.onStop(moves.arm());
    },
  });

  const signalHost: FerretSignalHost = {
    ready,
    record: ferret => registry.get(ferret),
    resolve: resolveFerret,
    waitingOf: ferret => registry.waitingOf(ferret),
    creditOf: async ferret => (await parkedFile(ferret)).creditSeconds,
    saveWaiting: async (ferret, waiting, creditSeconds) => {
      const { waiting: _before, creditSeconds: _credit, ...kept } = await parkedFile(ferret);
      await kernel.state.write(
        FerretWaitFiles,
        {
          ...kept,
          ...(waiting === undefined ? {} : { waiting }),
          ...(creditSeconds === undefined ? {} : { creditSeconds }),
        },
        ferret,
      );
      registry.putWaiting(ferret, waiting);
    },
    saveFinished: async (ferret, at) => {
      await kernel.state.write(FerretWaitFiles, { ...(await parkedFile(ferret)), finishedAt: at as never }, ferret);
      registry.putFinished(ferret, at);
    },
    writeSummary: async (ferret, text) => {
      await kernel.state.write(FerretSummaryFiles, new TextEncoder().encode(text), ferret);
    },
    history: appendHistory,
    // `signal done` is the ferret ending on its own word: its cause is `completed`, not a stop.
    stop: async (ferret, reason) => await service.stop(ferret, 'now', reason, { kind: 'completed' }),
  };
  const signalRoutes = sessionSignalRoutes(
    new FerretSignals(
      new SessionSignalService({
        repository: new FerretSignalRepository(signalHost),
        artifacts: new FerretSignalArtifacts(signalHost),
        terminal: new FerretSignalTerminal(signalHost),
        serial: new KeyedSerialExecutor(),
        clock: { now: () => kernel.clock.now() },
      }),
      { resolve: resolveFerret, view: async ferret => await service.get(ferret) },
    ),
  );
  // A ferret signals for itself and its helpers; a person for any ferret (the same rule as stop, resume and rename).
  const signals = {
    'POST /v1/ferrets/:ferretId/signal': async (call: CallContext): Promise<ApiResponse> => {
      mayAct(call, await pathFerret(call));
      return await signalRoutes['POST /v1/ferrets/:ferretId/signal'](call);
    },
  };
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
  const restartSubsystem = new FerretRestarts(
    restartService({
      ready,
      ferrets: () => registry.list(),
      waitingOf: ferret => registry.waitingOf(ferret),
      outdated: outdatedFor,
      stop: async (ferret, reason) => await service.stop(ferret, 'polite', reason),
      // The daemon's own restart: its turn is drawn as Ferretry's Restart, never as the owner's words.
      resume: async ferret => await service.resume(ferret, undefined, { actor: 'daemon' }),
      history: appendHistory,
      // An entry that does not parse is dropped on its own; the rest survive, and a queue that cannot be read is empty.
      loadQueue: async () => {
        const read = await kernel.state.read(RestartsFile);
        const queued = read.ok ? (read.value as { queued?: unknown } | undefined)?.queued : undefined;
        if (!Array.isArray(queued)) return [];
        return queued.flatMap(entry => {
          const parsed = RestartQueueEntrySchema.safeParse(entry);
          return parsed.success ? [parsed.data] : [];
        });
      },
      saveQueue: async entries => {
        await kernel.state.write(RestartsFile, { queued: entries });
      },
      now: () => kernel.clock.now(),
    }),
    { resolve: resolveFerret, mayTouch: (caller, target) => registry.mayTouch(caller, target) },
  );
  const restartRoutes = sessionRestartRoutes(restartSubsystem);
  const restarts = {
    ...restartRoutes,
    // Clearing the queue clears every ferret's waiting restart: a person's act.
    'DELETE /v1/restarts': async (call: CallContext): Promise<ApiResponse> => {
      if (callerFerret(call) !== undefined)
        throw new ApiError(403, 'a ferret does not clear the restart queue of every ferret', 'forbidden');
      return await restartRoutes['DELETE /v1/restarts'](call);
    },
  };
  // A waiting restart is tried again at its ferret's next idle moment; an empty queue costs no read.
  kernel.jobs.add({
    id: 'restart-drain',
    schedule: { every: milliseconds(10_000) },
    run: async () => await restartSubsystem.drain(),
  });
  // The archive (U6): finished autonomous ferrets leave the live set when `archive.yaml` says so and Board and Agenda have
  // both said what keeps a ferret live. Nothing moves, only a write revives, and the list below reads and writes nothing.
  const archive = buildArchive({
    storage: sessionStore,
    settings: () => kernel.config.file(ArchiveConfigFile),
    nowMs: () => kernel.clock.nowMs(),
    pinned: async () => await agentPins.pinnedAt(),
    keeps: () => hooks.contributions(ArchiveKeeps).map(contribution => contribution.item),
    // Kept by the record whatever the session document says: a ferret still running, and one the record does not say is
    // autonomous (a record with no `mode` is read as interactive, as the signal path reads it).
    isLive: ferret => {
      const record = registry.get(ferret as FerretId);
      return record !== undefined && (record.state !== 'stopped' || record.mode !== 'auto');
    },
    loaded: async () => await storeLoaded,
    yieldToLoop: async () => await kernel.clock.sleep(milliseconds(0)),
    // A view names its session's folder, and 5.0 names no state folder to any caller: the ferret's own id stands for it.
    directory: id => `sessions/${id}`,
    after: (delayMs, fire) => kernel.clock.after(milliseconds(delayMs), fire),
    log,
  });
  kernel.jobs.add({
    id: ARCHIVE_PASS_JOB,
    schedule: { every: milliseconds(ARCHIVE_TICK_MS) },
    run: async signal => await archive.tick(signal),
  });
  const archived = sessionArchiveRoutes(archive.subsystem);
  /** Whether the archive took this ferret out of the live set (a read: it writes nothing and revives nothing). */
  const isArchived = (ferret: string): boolean => sessionStore.isArchived(ferret as unknown as SessionId);
  /** Brings an archived ferret back into the live set; nothing for one that is live. */
  const reviveArchived = async (ferret: string): Promise<void> => {
    if (!isArchived(ferret)) return;
    await sessionStore.retainSession(ferret as unknown as SessionId);
  };

  // Pins (a3's handlers): the owner's sidebar pins (agent-pins.json) and each ferret's note board (<ferret>/pins.json).
  const pinnedReader = withPinned(
    {
      list: async () => {
        await ready();
        return registry
          .list()
          .map(ferret => registry.summary(ferret.id))
          .filter(summary => summary !== undefined);
      },
      get: async reference => {
        await ready();
        const resolution = resolveAgentAddress(
          reference,
          registry.list().map(ferret => ({ id: ferret.id, name: ferret.name, status: ferret.state })),
        );
        return resolution.kind === 'session' ? registry.summary(resolution.id as FerretId) : undefined;
      },
    },
    agentPins,
  );
  // A pin is a keep the owner wrote: pinning an archived ferret brings it back into the live set (the store's own
  // idempotent revival, ancestors included). A revival that fails answers the failure; pinning again retries it, since
  // the pin is already saved and the ferret is still archived.
  const pinSubsystem = new AgentPinSubsystem(pinnedReader, agentPins);
  const sidebarPins = sessionPinRoutes({
    pin: async reference => {
      const pinned = await pinSubsystem.pin(reference);
      await reviveArchived(pinned.id);
      return pinned;
    },
    unpin: async reference => await pinSubsystem.unpin(reference),
  });
  const noteBoard = pinRoutes({
    pins: new PinService(
      new RegistryPinSessionDirectory(ferret => registry.get(ferret as FerretId) !== undefined),
      new StatePinRepository(kernel.state, FerretPinsFile, pinClock),
      pinClock,
      { next: () => randomUUID() },
    ),
    ferretOf: pathFerret,
    callerOf: call => {
      const own = callerFerret(call);
      return { isAgent: callerIsAgent(call), ...(own === undefined ? {} : { ferret: own }) };
    },
  });

  /** SHA-256 hex of the exact body text, matching the digest the protocol client computes (today's `payloadDigests`). */
  const payloadDigest = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
  /** Starts under one request id run one at a time, so a retry racing its original cannot start a second ferret. */
  const startsInFlight = new Map<string, Promise<unknown>>();
  const oneAtATime = async <T>(requestId: string, work: () => Promise<T>): Promise<T> => {
    const before = startsInFlight.get(requestId) ?? Promise.resolve();
    const run = before.then(work, work);
    const settled = run.catch(() => undefined);
    startsInFlight.set(requestId, settled);
    try {
      return await run;
    } finally {
      if (startsInFlight.get(requestId) === settled) startsInFlight.delete(requestId);
    }
  };

  const startFailure = (failure: { readonly code: string; readonly reason: string }): never => {
    const status =
      failure.code === 'refused' || failure.code === 'unservable_model' ? 409 : failure.code === 'folder' ? 400 : 503;
    throw new ApiError(status, failure.reason, failure.code);
  };

  // Today's `findSession` also found archived ferrets, whose journals are untouched, so their streams replay.
  // `?live=1` and `?transcript=1` (U5, G161): the live readout and the transcript signal, each read through its owner and
  // masked on the way out (`modules/live-events.ts`).
  const liveEvents = buildLiveEvents({
    readState: async id => await sessionStore.readState(id),
    record: ferret => registry.get(ferret),
    runner: () => {
      const found = hooks.provider(Runners, 'tmux');
      return found === 'unavailable' ? undefined : found;
    },
    transcript: transcripts,
    clock: { now: () => kernel.clock.now() },
    every: (intervalMs, tick) => kernel.clock.every(milliseconds(intervalMs), tick),
    redaction: kernel.redaction,
  });
  const eventsAccept = fleetEventsAccept(
    eventSource,
    { after: (delay, action) => ({ cancel: kernel.clock.after(milliseconds(delay), action) }) },
    followableFerret({
      live: id => registry.get(id as FerretId) !== undefined,
      archived: id => {
        const session = tryParseSessionId(id);
        return session !== undefined && sessionStore.findSession(session) !== undefined;
      },
    }),
    {
      ...liveEvents,
      // A ferret's own token follows its own live readout and its helpers', never another's (G161).
      mayFollow: (call, id) => mayAct(call, id as FerretId),
    },
  );

  return {
    provides: {
      ferrets: ferretsPort(service),
      workFolders,
      agentControl: agentControlReader(ferret => service.agentControl(ferret)),
    },
    tools: {
      // Today's `instructions`: answered for the ferret the session credential names, from what ITS launch told it.
      instructions: async call =>
        await instructionsAnswer(callerFerret(call), id => launchEnvironment.read(id), kernel.identity.binaries.client),
    },
    hooks: {
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
    sockets: {
      'GET /v1/events': async call => {
        // The archive is read once at open; a stream asked for before that must not 404 an archived ferret.
        await storeLoaded.catch(() => undefined);
        return await eventsAccept(call);
      },
    },
    routes: {
      ...worktrees.routes,
      ...moveRoutes,
      ...fileBrowser,
      ...signals,
      ...restarts,
      ...archived,
      'POST /v1/ferrets/:ferretId/pin': sidebarPins.pin,
      'POST /v1/ferrets/:ferretId/unpin': sidebarPins.unpin,
      'GET /v1/ferrets/:ferretId/pins': noteBoard.list,
      'POST /v1/ferrets/:ferretId/pins': noteBoard.apply,
      // The LIVE list: a ferret the archive took out of the live set is left out (nothing is deleted: its record, its
      // documents and `GET /v1/ferrets/:id` stay, and a write brings it back); `GET /v1/archived-sessions` lists it.
      'GET /v1/ferrets': async call => {
        await ready();
        await storeLoaded.catch(() => undefined);
        // Hidden only while ARCHIVED AND STOPPED: a ferret the record holds in any other state is live whatever the archive
        // flag says (an adopted live pane writes only the record, and a revival's document write may still be on its way).
        const live = (await service.list()).filter(
          summary => !hiddenFromLiveList(summary.state, isArchived(summary.id)),
        );
        return fleetList.answer(await outdatedMarks.list(live), headerValue(call.request, 'if-none-match'));
      },
      'GET /v1/ferrets/:ferretId/subtree': async call => {
        const id = await pathFerret(call);
        mayAct(call, id);
        const view = await subtree.view(id);
        if (view === undefined) throw new ApiError(404, `no ferret ${id}`, 'not-found');
        return jsonResponse(SubtreeViewSchema.parse(view));
      },
      'GET /v1/ferrets/:ferretId': async call => {
        const id = await pathFerret(call);
        const summary = await service.get(id);
        return jsonResponse(summary === undefined ? summary : await outdatedMarks.one(summary));
      },
      'POST /v1/ferrets': async call => {
        await ready();
        const text = await call.request.text();
        const parsed = parseStartBody(parseJson(text));
        const own = callerFerret(call);
        // Today's `lineageOf` (G12): a ferret starts only its own helpers. Naming any other parent is refused; naming
        // none is filled from its token below, so a ferret never starts a parent-less ferret. The owner (no ferret on the
        // call) may start under any parent, which must exist, or none.
        if (own !== undefined && parsed.parent !== undefined && parsed.parent !== own)
          throw new ApiError(
            403,
            'a ferret starts sessions only as its own children; leave the parent out, the daemon reads it from your session',
            'parent_mismatch',
          );
        if (own === undefined && parsed.parent !== undefined && registry.get(parsed.parent) === undefined)
          throw new ApiError(404, `there is no ferret ${parsed.parent} to start a helper of`, 'unknown_parent');
        // The Warden's own label marks the Warden's tree (exempt from the helper limits and supervision); only the Warden
        // starts under it, so an agent asking for it is refused, as today.
        if (parsed.options?.label?.trim() === WARDEN_LABEL && callerIsAgent(call))
          throw new ApiError(
            403,
            'only the Warden starts a ferret under its own label; leave --label out',
            'owner_only',
          );
        // No identity/link-hop state-home reach is available in this kernel yet. Never replace it with a lexical fence.
        await stateHomeLaunchRefusal(callerIsAgent(call), stateHomeReach, parsed.folder);
        // Project catalogs and the managed-root launch seam are unbound; a governed start fails closed without them.
        await terminalLaunchRefusal(call, parsed, undefined);
        let startedFerret: FerretId | undefined;
        const start = async (): Promise<ApiResponse> => {
          const started = await service.start({
            ...parsed,
            // A ferret's start is its helper: the parent is the caller, never a value from the request.
            ...(own === undefined ? {} : { parent: own }),
            by: own === undefined ? 'owner' : 'ferret',
          });
          if (!started.ok) return startFailure(started.error);
          startedFerret = started.value;
          return jsonResponse({ id: started.value }, 201);
        };
        // A start is IDEMPOTENT on its request id (today's retry contract): the same id and body answer the ferret it
        // already started; the same id with another body is a conflict, never a second ferret.
        const requestId = headerValue(call.request, FY_REQUEST_ID_HEADER)?.trim();
        if (requestId === undefined || requestId === '')
          throw new ApiError(
            400,
            `a start must carry ${FY_REQUEST_ID_HEADER}: without it a retried request starts a second session`,
            'missing_request_id',
          );
        const digest = payloadDigest(text);
        return await oneAtATime(requestId, async () => {
          const held = await kernel.state.read(StartRequestsFile);
          const seen = lookupStartRequest(held.ok ? held.value : undefined, requestId, digest);
          if (seen.kind === 'same') return jsonResponse({ id: seen.ferret });
          if (seen.kind === 'conflict')
            throw new ApiError(
              409,
              `request id ${JSON.stringify(requestId)} already started a different ferret`,
              'request_id_reused',
            );
          const answer = await start();
          const ferret = startedFerret;
          if (ferret !== undefined) {
            await kernel.state.update(StartRequestsFile, current =>
              withStartRequest(current, { requestId, digest, ferret, at: kernel.clock.now() }),
            );
          }
          return answer;
        });
      },
      // Four segments deep with a literal third, so `by-request` can never be mistaken for a ferret id (R-0187).
      'GET /v1/ferrets/by-request/:requestId': async call => {
        await ready();
        const id = decodeParameter(call.params.get('requestId') ?? '');
        if (id === undefined || id === '')
          throw new ApiError(400, 'the request id in the path is not usable', 'invalid_request_id');
        const digest = call.request.query.get('payload')?.[0]?.trim() ?? '';
        if (digest === '')
          throw new ApiError(
            400,
            'a recovery read must carry ?payload=<sha-256 of the start body>: without it any caller could ask which session a request id produced',
            'missing_payload_digest',
          );
        const held = await kernel.state.read(StartRequestsFile);
        const seen = lookupStartRequest(held.ok ? held.value : undefined, id, digest);
        if (seen.kind === 'conflict')
          throw new ApiError(409, `request id ${JSON.stringify(id)} started a different ferret`, 'request_id_reused');
        const summary = seen.kind === 'same' ? await service.get(seen.ferret) : undefined;
        if (summary === undefined)
          throw new ApiError(404, `no start by this daemon carries request id ${JSON.stringify(id)}`, 'not-found');
        return jsonResponse(summary);
      },
      'POST /v1/ferrets/:ferretId/stop': async call => {
        const id = await pathFerret(call);
        mayAct(call, id);
        const how = queryValue(call.request, 'how') === 'now' ? 'now' : 'polite';
        const { reason } = parseStopBody(await body(call));
        await service.stop(id, how, reason);
        return jsonResponse({ id, state: registry.get(id)?.state });
      },
      'POST /v1/ferrets/:ferretId/resume': async call => {
        const id = await pathFerret(call);
        mayAct(call, id);
        const { message } = parseResumeBody(await body(call));
        const resumed = await service.resume(id, message, {
          confirmRestore: confirmRestore(call, callerIsAgent(call)),
          actor: resumeActorOf(call),
        });
        if (!resumed.ok) return startFailure(resumed.error);
        return jsonResponse({ id: resumed.value });
      },
      'POST /v1/ferrets/:ferretId/rename': async call => {
        const id = await pathFerret(call);
        mayAct(call, id);
        const renamed = await service.rename(id, parseRenameBody(await body(call)));
        if (!renamed.ok) {
          const refusal = RENAME_HTTP[renamed.error.failure];
          throw new ApiError(refusal.status, renamed.error.message, refusal.code);
        }
        return jsonResponse(renamed.value);
      },
      'POST /v1/ferrets/:ferretId/revoke-credential': async call => {
        const id = await pathFerret(call);
        return jsonResponse({ id, revoked: await service.revokeToken(id) });
      },
      'GET /v1/names': async call => {
        await ready();
        const raw = queryValue(call.request, 'count');
        const count = raw === undefined ? 1 : Number(raw);
        if (!Number.isInteger(count) || count < 1)
          throw new ApiError(400, 'count must be a whole number of at least one', 'invalid_count');
        await archiveRead();
        const nowMs = kernel.clock.nowMs();
        // A suggestion, not a reservation: the names the fleet holds (a stopped ferret's inside its window), as today.
        const start = Math.floor(nowMs / 1000) % DEFAULT_CALLSIGN_POOL.length;
        return jsonResponse([...suggestCallsigns(DEFAULT_CALLSIGN_POOL, heldClaims(), nowMs, count, start)]);
      },
    },
  };
}

/** Ferrets' daemon half (§2.2). */
export default implementDaemon(manifest, { build });
