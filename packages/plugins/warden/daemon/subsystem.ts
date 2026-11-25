import { posix } from 'node:path';
import { milliseconds } from '@ferretry/std';
import type { AsksApi } from '@ferretry/core-asks/contract';
import type { FerretId, FerretsApi } from '@ferretry/core-ferrets/contract';
import type { KernelPorts } from '@ferretry/kernel/contract';
import type { BoardApi } from '@ferretry/plugin-board/contract';
import type { BrowsersApi } from '@ferretry/plugin-browsers/contract';
import type { ConversationApi } from '@ferretry/plugin-conversation/contract';
import type { RuntimesApi } from '@ferretry/plugin-runtimes/contract';
import type { TerminalsApi } from '@ferretry/plugin-terminals/contract';
import type { LoginFactsApi, OwnerHoldApi, UsageHeadroomApi } from '../contract/others.ts';
import { WARDEN_CONFIG, WardenActed, WardenConfigChanged, WardenFlagged } from '../contract/index.ts';
import { AsksWardenAgenda, NoticeEntries } from './asks.ts';
import { boardReader } from './board.ts';
import {
  ConfigWardenConfigStore,
  FileWardenArtifacts,
  ScratchWardenWorkFolders,
  kernelSecretSender,
  StateMachineMembers,
  StateWardenJevCheckLog,
  StateWardenReportFiles,
  StateAutoMoveLedger,
  StateWardenStateStore,
  WardenReportReader,
  runtimesWardenAgents,
} from './adapters/index.ts';
import { WardenFleetFacts } from './adapters/fleet-facts.ts';
import {
  exchangeSends,
  HARNESS_OF,
  limitedFerrets,
  livenessTargets,
  readFleet,
  reviveEventsOf,
  statusOf,
  TurnOrdinals,
  transcriptDigest,
  withLiveness,
  withRateLimited,
} from './fleet.ts';
import { onceFiled } from './lib/filed-reports.ts';
import { createWardenRemedies } from './remedies.ts';
import { ferretsWardenSpawner } from './spawner.ts';
import { conversationStuckInbox, conversationStuckInput } from './stuck-ports.ts';
import { agendaDialogNotices, ferretDialogs } from './dialogs.ts';
import { dialogRulesInEffect, ferretClearPane } from './dialog-clear.ts';
import { dialogLearnService, dialogRulesView } from './dialog-learn.ts';
import { builtInDialogRules, type DialogRuleProvision } from './dialog-rules-source.ts';
import type { DialogLearnAnswer, DialogLearnRequest, DialogRulesView } from '../contract/dialog-rules.ts';
import {
  AUTO_MOVE_FAILED_REF,
  AutoMoveFailures,
  DIALOG_CLEAR_REF,
  DIALOG_PROPOSALS_REF,
  DIALOG_WATCH_REF,
  DialogLearnRefused,
  INBOX_STUCK_REF,
  INPUT_STUCK_REF,
  type LivenessSample,
  StuckInboxList,
  StuckInputList,
  ownerHoldReason,
  WARDEN_SWEEP_ORIGIN,
  EMPTY_AUTO_MOVE_MEMORY,
  type WardenSaveOptions,
  parseAutoMoveMemory,
  waitingFerrets,
  WardenAutoMoveService,
  WardenDialogClear,
  WardenDialogWatch,
  type WardenAgentInventory,
  WardenLivenessMonitor,
  WardenReviveService,
  WardenSweepLoop,
  WardenSweepService,
  type WardenSpawner,
  type WardenReadScope,
  wardenTriggerEnabled,
} from './lib/index.ts';
import { parseStoredWardenConfig, parseWardenConfigPatch } from './lib/config.ts';
import { JevTriageGuard } from './lib/jev.ts';
import type {
  WardenAgendaView,
  WardenInvestigateView,
  WardenRunView,
  WardenStatusView,
  WardenVerdict,
} from './lib/protocol.ts';
import { wardenFlags } from './lib/protocol.ts';
import { isoFromMs } from './lib/time.ts';

/** The reports folder inside the warden's own state; a report's path is `reports/<stamp>.md`. */
const REPORTS_DIRECTORY = 'reports';

/** What the warden needs of the rest of the daemon: ports it was handed, and the optional Usage and Board. */
export interface WardenHost {
  readonly kernel: KernelPorts;
  readonly ferrets: FerretsApi;
  readonly conversation: ConversationApi;
  readonly asks: AsksApi;
  readonly usage: () => UsageHeadroomApi | undefined;
  /** Logins, when it is on: each login's sign-in word, quota and budget, for the auto-move's facts. Off: nothing is moved. */
  readonly logins?: () => LoginFactsApi | undefined;
  /** Accounts, when it is on: its one owner-hold yes or no. Off: nothing is moved (a hold cannot be checked). */
  readonly accounts?: () => OwnerHoldApi | undefined;
  /** Runtimes, when it is on: the catalog the auto-move chooses a login from. Off: nothing is moved. */
  readonly runtimes?: () => RuntimesApi | undefined;
  /** Board, when it is on: read at each sweep, never during build. */
  readonly board: () => BoardApi | undefined;
  /** Terminals, when it is on: the liveness look at each ferret's own pane. Off, the liveness checks do not run. */
  readonly terminals?: () => TerminalsApi | undefined;
  /** Browsers, when it is on: it closes the browsers left under a ferret's pane. Off, that check does not run. */
  readonly browsers?: () => BrowsersApi | undefined;
  /**
   * The built-in dialog rules each harness plugin provides, read now (`warden.dialog-rules.<harness>`): a harness that
   * provides none, or whose plugin is off, has none. Absent: no built-in rules at all.
   */
  readonly dialogRules?: () => readonly DialogRuleProvision[];
}

/** What the routes serve (today's `WardenSubsystem`, in the contract's words where they differ). */
export interface WardenSubsystem {
  /**
   * A scope narrows the ROWS of every list before its cut (see `WardenReadScope`). What a ferret is TOLD of the answer
   * is `ferretWardenView`'s, applied by the route: a scoped answer is never served as it is.
   */
  status(scope?: WardenReadScope): Promise<WardenStatusView>;
  verdicts(scope?: WardenReadScope): Promise<readonly WardenVerdict[]>;
  /** One report's text: the owner's and a person's. The route never asks for it on a ferret's behalf. */
  report(reportPath: string): Promise<string | undefined>;
  run(spawn: boolean): Promise<WardenRunView>;
  config(): ReturnType<WardenSweepService['view']>;
  /** `nameJevKey`: the same write also names the Jev key, so a save that must name it is ONE write of `warden.yaml`. */
  updateConfig(patch: unknown, options?: WardenSaveOptions): ReturnType<WardenSweepService['updateConfig']>;
  /** The owner's act of naming the Jev key in `warden.yaml`; held for the owner unless the kernel finds the caller is. */
  nameJevKey(): ReturnType<WardenSweepService['view']>;
  agenda(scope?: WardenReadScope): Promise<WardenAgendaView>;
  investigate(ferret: string, note?: string): Promise<WardenInvestigateView>;
  leave(ferret: string, duration: '1h' | '4h' | 'until_change'): ReturnType<WardenSweepService['leaveAlone']>;
  /** An event that may bring the next sweep forward (a turn ended, a ferret stopped). */
  nudgeSweep(trigger: 'turnEnd' | 'question' | 'paneDied'): void;
  /** A ferret was launched (started, resumed, revived, restarted, model switch): its quiet clock starts again now. */
  launched(ferret: string): void;
  arm(): () => void;
}

/** A turn's wall-clock is the kernel's: monotonic time for the guard's latency. */
const stopwatch = { monotonicMs: (): number => performance.now() };

/** How often the liveness monitor looks at every working ferret: kteam's own tick (today's). */
export const WARDEN_LIVENESS_TICK_SECONDS = 30;

/** How often the dialog look runs: a screen a rule can leave should not wait half a minute. */
const WARDEN_DIALOG_TICK_SECONDS = 10;

/** The binary's name, for sentences that name a command a ferret types; the other halves quote it the same way. */
const BINARY = 'fy';

/** Teaching Ferretry a screen it does not know (`dialog-learn.ts`): what it clears, and the propose-then-save flow. */
export interface WardenDialogs {
  /** What Ferretry clears by itself, what the owner taught it and what waits for a yes. */
  rules(): Promise<DialogRulesView>;
  /** Propose a rule from a ferret's dialog, or save the one proposed (the owner's yes). */
  learn(request: DialogLearnRequest): Promise<DialogLearnAnswer>;
}

export function createWardenSubsystem(host: WardenHost): WardenSubsystem & { readonly dialogs: WardenDialogs } {
  const { kernel, ferrets, conversation, asks } = host;
  const nowMs = (): number => kernel.clock.nowMs();
  const turns = new TurnOrdinals();
  const entries = new NoticeEntries();
  const agenda = new AsksWardenAgenda(asks, entries);
  const machineNotices = agenda.machineNotices();
  const nowIso = (): string => new Date(kernel.clock.nowMs()).toISOString();
  const files = new StateWardenReportFiles(kernel.state);
  const reader = new WardenReportReader(files, REPORTS_DIRECTORY);
  // A finished investigator's report is the summary of its last `signal done`, masked before it is filed.
  const artifacts = new FileWardenArtifacts(files, reader, REPORTS_DIRECTORY, async investigator => {
    const summary = await ferrets.summary(investigator as FerretId);
    if (summary === undefined) return undefined;
    return await kernel.redaction.read(async scope => scope.text(summary));
  });
  const configStore = new ConfigWardenConfigStore(kernel.config);
  /** Every settings answer says whether `warden.yaml` names the Jev key: a fact about a reference, never the key. */
  const naming = <View extends object>(view: View): View & { readonly jevKey: 'named' | 'not_named' } => ({
    ...view,
    jevKey: configStore.jevKeyNamed() ? 'named' : 'not_named',
  });
  // A settings screen hears warden.yaml move the moment the kernel reloads it, from any editor (not only on mount).
  kernel.config.watch(WARDEN_CONFIG, () => kernel.events.publish(WardenConfigChanged, {}));

  const acted: Parameters<typeof createWardenRemedies>[0]['acted'] = (ferret, action, outcome, leftAlone) =>
    kernel.events.publish(WardenActed, {
      ferret: ferret as FerretId,
      action,
      outcome,
      ...(leftAlone === undefined || leftAlone.length === 0 ? {} : { leftAlone: [...leftAlone] }),
    });
  // ── the remedies: every one goes through Ferrets or Conversation, never around them (`remedies.ts`) ──────────────
  const terminals = (): TerminalsApi | undefined => host.terminals?.();
  const browsers = (): BrowsersApi | undefined => host.browsers?.();
  const { remedies, resume: automaticResume } = createWardenRemedies({
    ferrets,
    conversation,
    asks,
    acted,
    browsers,
    noticeUndelivered: (ferret, reason) => kernel.log.info('warden.notice_undelivered', { ferret, reason }),
  });
  const fleetNow = async () => await readFleet(ferrets, conversation, asks, turns, ferret => `ferrets/${ferret}`);

  // ── the liveness monitor: what the Warden SEES of each working ferret between sweeps (today's) ────────────────────
  // Each tick takes Terminals' look at the ferret's own pane (masked screen, process tree) and Conversation's digest of
  // its transcript tail; the monitor folds them into the ledger the sus classifiers read and says which ferrets it is
  // watching. It runs only while Terminals is on: off, no ferret is looked at, Ferrets' own account stands in (a
  // running ferret counts as watched) and `dead_monitor`, `sus_*` and `agent_frozen` do not run.
  const liveness = new WardenLivenessMonitor(
    {
      targets: async () => livenessTargets(await fleetNow()),
      sample: async target => {
        const pane = terminals();
        if (pane === undefined) return {};
        const [sample, transcriptHash] = await Promise.all([
          pane.liveness(target.id as FerretId).catch((): LivenessSample => ({})),
          transcriptDigest(conversation, target.id as FerretId),
        ]);
        return { ...sample, ...(transcriptHash === undefined ? {} : { transcriptHash }) };
      },
      nowMs,
    },
    WARDEN_LIVENESS_TICK_SECONDS,
  );
  // Armed while Terminals is on and the sweep is armed; a monitor that is not armed is never read.
  let livenessArmed = false;
  const monitorOn = (): boolean => livenessArmed && terminals() !== undefined;
  const syncLiveness = (): boolean => {
    const on = terminals() !== undefined;
    if (on && !livenessArmed) liveness.arm();
    if (!on && livenessArmed) liveness.disarm();
    livenessArmed = on;
    return on;
  };

  // ── auto-revive: today's default-on revive, resuming through Ferrets under today's automatic refusals ─────────────
  // It revives only a ferret that DIED (status `failed`, its last terminal event an abnormal exit: `classifyEnd`). What
  // the session journal said is now Ferrets' own `FerretSummary.cause`, read back as that one event (`reviveEventsOf`).
  // The breaker, the per-day caps and the owner's `mayActAlone.resume` govern it as before.
  const revive = new WardenReviveService({
    events: {
      read: async ferret => reviveEventsOf(await ferrets.get(ferret as FerretId)),
      emit: async (ferret, type, data) => kernel.log.info(type, { ferret, ...scalars(data) }),
    },
    resume: automaticResume,
    // Ferrets owns the runner and refuses a resume it cannot start; there is no separate tmux server to wait for.
    tmuxReady: async () => true,
    // The machine's "Auto-resume after restart" switch, Runtimes' to answer (no per-ferret switch exists). Runtimes off, or
    // unable to say, is no: the revive then does nothing, as a hold that cannot be checked is a hold.
    autoResume: async () => await host.runtimes?.()?.autoResume(),
    sleep: async ms =>
      await new Promise<void>(resolve => {
        kernel.clock.after(milliseconds(ms), resolve);
      }),
    notifyOwner: async notice => {
      // The breaker's one notice lands on the ferret that tripped it, as a plain notification (today's); a ferret left
      // dead at the hourly cap gets the same kind of notice, one per ferret per hour.
      await agenda.notice(
        notice.sessionId,
        notice.kind === 'cap'
          ? {
              sourceRef: 'warden-revive-cap',
              subject: `${notice.title}: ${notice.subject}`,
              why: notice.why,
              context: 'Auto-revive left one ferret stopped after it died four times in an hour.',
              howToResolve: 'Nothing to answer. Look at why it keeps dying, then resume it yourself.',
            }
          : {
              sourceRef: 'warden-revive-breaker',
              subject: `${notice.title}: ${notice.subject}`,
              why: notice.why,
              context: 'Auto-revive paused itself after revived sessions kept dying.',
              howToResolve:
                'Nothing to answer. Look at why sessions keep dying; revives resume by themselves after the pause.',
            },
      );
    },
    journal: { record: (type, data) => kernel.log.info(type, scalars(data)) },
  });

  // ── investigators ────────────────────────────────────────────────────────────────────────────────────────────────────
  // Each starts through Ferrets as the Warden, in a folder of its own that the kernel's scratch port made outside the
  // Ferretry home (never the home, never a project), and hands its report back with `signal done` (`spawner.ts`).
  const workFolders = new ScratchWardenWorkFolders(kernel.scratch);
  const spawner: WardenSpawner = ferretsWardenSpawner({ ferrets, folders: workFolders });

  // The logins an investigation may run on: this machine's agent runtimes by NAME, and its default runtime for an owner who
  // never chose one (`runtime-agents.ts`). Runtimes not answering is "unreadable": it condemns no account and leaves the login
  // not set. Ferrets resolves the runtime at the start itself and refuses a signed-out one: the sweep then strikes that
  // account and tries the next, which is the check that matters. (The harness keys Ferrets lists are not runtime names.)
  const agents: WardenAgentInventory = runtimesWardenAgents(() => host.runtimes?.());

  // ── auto-move: a ferret on a login that hit its limit goes to one with room (`auto-move-service.ts`) ────────────────
  // No Jev, no investigation, no spend: a rule over recorded facts and the owner's `autoMove` setting. The act is
  // Ferrets' own move (same session, same conversation), under its own safety check and NEVER forced; the Warden only
  // chooses the login, and only for a ferret nothing of the owner's is open on.
  const facts = new WardenFleetFacts(
    () => host.runtimes?.(),
    () => host.logins?.(),
    () => host.usage(),
    async () => (await ferrets.paneLimits?.()) ?? [],
    () => kernel.clock.now() as string,
  );
  const moveLedger = new StateAutoMoveLedger(kernel.state);
  /** The ferrets the mover remembers waiting for a limit to reset: read again once Ferrets stops showing the limit. */
  const waitingForReset = async (): Promise<readonly string[]> => {
    try {
      return waitingFerrets(parseAutoMoveMemory(await moveLedger.read()) ?? EMPTY_AUTO_MOVE_MEMORY);
    } catch {
      return [];
    }
  };
  // The ferrets the mover could not move, as ONE machine item (`auto-move-failures.ts`), beside the stuck-input list below.
  // It lists a ferret where the failure is recorded, and drops it once the ferret is moved, stopped or gone.
  let autoMoveService: WardenAutoMoveService | undefined;
  const autoMoveFailures = new AutoMoveFailures(
    new StateMachineMembers(kernel.state, AUTO_MOVE_FAILED_REF),
    machineNotices,
    {
      // A stopped or gone ferret needs no move: `undefined`.
      current: async sessionId => {
        const ferret = await ferrets.get(sessionId as FerretId).catch(() => undefined);
        if (ferret === undefined || ferret.state === 'stopped') return undefined;
        return {
          agent: ferret.runtime ?? ferret.harness,
          name: ferret.name,
          midTurn: ferret.state === 'working',
        };
      },
      // The login the mover's own ranking would pick for it now (the first ready one), or none.
      candidate: async sessionId => {
        const ferret = await ferrets.get(sessionId as FerretId).catch(() => undefined);
        const harness = ferret === undefined ? undefined : HARNESS_OF[ferret.harness];
        if (ferret === undefined || harness === undefined || autoMoveService === undefined) return undefined;
        const config = parseStoredWardenConfig(await configStore.read()).config;
        const [candidates] = await autoMoveService.moveCandidates(
          [
            {
              config: {
                id: ferret.id,
                mode: ferret.mode ?? 'interactive',
                agent: ferret.runtime ?? ferret.harness,
                harness,
              },
            },
          ],
          config,
        );
        return candidates?.candidates[0];
      },
    },
    nowIso,
  );
  const autoMove = new WardenAutoMoveService({
    failed: async (sessionId, detail, quiet) => await autoMoveFailures.note(sessionId, detail, quiet),
    settled: async () => await autoMoveFailures.reconcile(),
    facts: async () => await facts.facts(),
    // ONE yes or no from Accounts (an input card, a sign-in waiting on their phone, a plan card or a copied secret all
    // answer it), then the ferret's own prompt. A check that cannot be made is a reason not to move.
    // GAP(warden): a terminal or browser the ferret handed to the owner is not on any 5.0 port, so it is not checked.
    ownerHold: async sessionId => {
      const held = host.accounts?.()?.ownerHold?.(sessionId);
      if (held === undefined)
        return "whether something of the owner's is open on it could not be checked (Accounts did not answer)";
      if (held)
        return 'it has something of the owner open (an input, a sign-in approval on their phone, a plan or a secret it copied)';
      return await ownerHoldReason(
        {
          inputCardOpen: () => false,
          phoneApprovalOpen: () => false,
          planAwaitingOwner: () => false,
          heldSecrets: () => 0,
          surfaceAsked: async () => false,
          state: async id => {
            const [summary, prompt] = await Promise.all([
              ferrets.get(id as FerretId),
              ferrets.prompt?.(id as FerretId),
            ]);
            if (summary === undefined || prompt === undefined) return undefined;
            return {
              status: statusOf(summary),
              ...(prompt.permissionRequest === undefined ? {} : { permissionRequest: prompt.permissionRequest }),
              ...(prompt.dialog === undefined ? {} : { harnessDialog: prompt.dialog }),
            };
          },
        },
        sessionId,
      );
    },
    // Ferrets reads no background job and its move refuses one in flight (never forced), so the mover sees none: a
    // ferret with jobs is refused by the move's own check and the owner is told, as a failed move. The ask-to-stop and
    // force-stop paths need a Ferrets read of the jobs that 5.0 does not publish yet (GAP).
    blockingJobs: async () => [],
    askToStopJobs: async () => undefined,
    stopJobs: async () => ({ stopped: [], survivors: [] }),
    move: async (sessionId, request) => {
      if (ferrets.move === undefined) throw new Error('Moving a ferret to another account is not available here.');
      const moved = await ferrets.move(sessionId as FerretId, request.agent, {
        origin: WARDEN_SWEEP_ORIGIN,
        actor: 'warden',
        movedBy: 'warden',
        note: request.note,
      });
      if (!moved.ok) throw new Error(moved.error.reason);
    },
    // The same guarded resume every Warden act makes (`remedies.resume`: it refuses where today's authorizeResume does).
    resume: async (sessionId, message) => {
      await remedies.resume(sessionId, message, WARDEN_SWEEP_ORIGIN);
    },
    agentOf: async sessionId => {
      const ferret = await ferrets.get(sessionId as FerretId).catch(() => undefined);
      return ferret === undefined ? undefined : (ferret.runtime ?? ferret.harness);
    },
    ledger: moveLedger,
    notifyOwner: async notice => {
      await agenda.notice(notice.sessionId, {
        sourceRef: 'warden-auto-move',
        subject: `${notice.title}: ${notice.subject}`,
        why: notice.why,
        context: 'The Warden moves a ferret whose login hit a limit to another login.',
        howToResolve: 'Nothing to answer. Move the ferret yourself if you want it on another login now.',
      });
    },
    emit: async (sessionId, type, data) => kernel.log.info(type, { ferret: sessionId, ...scalars(data) }),
    journal: { record: (type, data) => kernel.log.info(type, scalars(data)) },
  });
  autoMoveService = autoMove;

  const service = new WardenSweepService(
    {
      orphans: {
        // Every orphaned card nobody can be messaged about is a row of ONE item on the machine board, as v4 listed
        // them (`AsksApi.standing`): the same item while the list changes, nothing written when it is the same,
        // closed when it is empty, and raised again after the owner closed it only when a card joins. An Agenda that
        // refuses it makes the sweep journal `fleet.warden_orphan_failed` once per reason and try again next sweep:
        // one attempt of one item.
        sync: async (item, announce) => {
          await agenda.standingOrphans(item, announce);
        },
        // The per-card asks an earlier Warden left on ferret boards, closed once (the memory names which boards).
        remove: async resolution => {
          await agenda.resolveSource(resolution.sessionId, 'agent-raised', resolution.sourceRef, resolution.note);
        },
      },
      // THE SEAM THAT KEEPS "NO UNATTENDED SPEND BY SURPRISE": the Jev key is spent only by the kernel
      // (`kernel.secrets.send`, D2 #19), and only once the OWNER wrote `jev.key: ${secret:JEV_API_KEY}` into warden.yaml;
      // until then every call is `not_set` and nothing leaves the machine. The layer and its caps still gate each call.
      // GAP(warden): this one line is untested through a sweep (5.0 Ferrets reports no state a Jev-triaged flag comes
      // from); the guard over `kernelSecretSender` is tested on a host with the Warden's own manifest
      // (tests/unit/jev-kernel-secret.test.ts).
      guard: () => new JevTriageGuard(kernelSecretSender(kernel.secrets), stopwatch),
      evidence: { evidence: async () => ({ recentTurns: [] }) },
      redactor: { batch: async work => await kernel.redaction.read(scope => work({ text: text => scope.text(text) })) },
      remedies,
      // An investigation is priced from its OWN analytics row — one keyed read per investigation, never a read of the
      // whole history per item. Unpriced (or Usage off) is `undefined`, and the sweep asks again for a day.
      costs: { costUsd: async investigator => await host.usage()?.sessionCostUsd?.(investigator) },
      feed: { board: async ferret => await agenda.feed(ferret) },
      fleet: {
        fleet: async () => {
          const fleet = await fleetNow();
          const limited = await limitedFerrets(ferrets, await waitingForReset());
          if (!monitorOn()) return withRateLimited(fleet, limited);
          const now = isoFromMs(nowMs());
          const leftovers = browsers() !== undefined;
          return withRateLimited(
            fleet.map(session => withLiveness(session, liveness, now, leftovers)),
            limited,
          );
        },
        // A monitor that has stopped seeing is ONE fault of this daemon, never one per ferret.
        monitorStalled: () => monitorOn() && liveness.stalled(),
      },
      spawner,
      artifacts: onceFiled(artifacts),
      state: new StateWardenStateStore(kernel.state),
      config: configStore,
      agents,
      usage: { accounts: async () => [] },
      verdicts: { recent: async scope => await reader.readVerdicts(undefined, scope).catch(() => undefined) },
      attention: agenda,
      journal: { record: (type, data) => kernel.log.info(type, scalars(data)) },
      jevChecks: new StateWardenJevCheckLog(kernel.state, nowMs),
      revive,
      autoMove,
      // Board off (or not loaded): no port, so no card is reported orphaned and none is cleared.
      board: () => {
        const board = host.board();
        return board === undefined
          ? undefined
          : boardReader(board, {
              // A helper is a ferret another ferret started: it may not move cards, so its brief does not say to.
              isHelper: async ferret => (await ferrets.get(ferret as FerretId))?.parent !== undefined,
            });
      },
      // The send ledgers: a sub-ferret overdue on a report its parent asked for is flagged `report_overdue`, nudged
      // once, and its parent told (a ferret that declared a wait or said `signal done` is skipped).
      exchanges: { sends: async ferret => await exchangeSends(conversation, ferret as FerretId) },
      // A message of ours typed and never sent, and a queue stuck far past due (B187): both checks read Conversation's
      // ledger and queue, act only through its verified paths, and list a ferret on ONE machine notice each.
      stuckInput: conversationStuckInput(
        conversation,
        new StuckInputList(new StateMachineMembers(kernel.state, INPUT_STUCK_REF), machineNotices, nowIso),
        { record: (type, data) => kernel.log.info(type, data) },
        ferrets,
      ),
      stuckInbox: conversationStuckInbox(
        conversation,
        new StuckInboxList(new StateMachineMembers(kernel.state, INBOX_STUCK_REF), machineNotices, nowIso),
      ),
      nowMs,
      capabilities: () => `${crypto.randomUUID()}${crypto.randomUUID().replaceAll('-', '')}`,
    },
    {
      clientName: BINARY,
      wardenCwd: '',
      supervisesMonitors: true,
      mayAct: false,
      machineName: () => undefined,
    },
  );

  // ── dialog watch: a ferret parked on a harness screen nothing pre-answered is told to the owner ONCE per episode ───
  // Not a flag and not a sweep step: a rule over the dialog Ferrets already recorded (`dialog-watch.ts`).
  // A screen a rule knows how to leave is left in the same look, before the owner is told of anything (`dialog-clear.ts`).
  const builtInRules = builtInDialogRules(host.dialogRules ?? (() => []), (type, data) => kernel.log.info(type, data));
  const dialogClear = new WardenDialogClear({
    rules: dialogRulesInEffect(kernel.config, builtInRules),
    nudgeOf: ruleId => builtInRules.nudgeOf(ruleId),
    ...ferretClearPane(ferrets),
    sleep: async ms => await kernel.clock.sleep(milliseconds(ms)),
    memory: new StateMachineMembers(kernel.state, DIALOG_CLEAR_REF),
    record: (type, data) => kernel.log.info(type, data),
  });
  const dialogWatch = new WardenDialogWatch({
    dialogs: async () => await ferretDialogs(ferrets, fleetNow),
    memory: new StateMachineMembers(kernel.state, DIALOG_WATCH_REF),
    notices: agendaDialogNotices(agenda),
    clear: dialogClear,
    record: (type, data) => kernel.log.info(type, data),
  });

  // ── teaching Ferretry a screen it does not know: a proposal the owner reads, then saves ──
  const dialogProposals = new StateMachineMembers(kernel.state, DIALOG_PROPOSALS_REF);
  const dialogLearn = dialogLearnService({
    ferrets,
    config: kernel.config,
    state: kernel.state,
    mask: async text => await kernel.redaction.read(async scope => scope.text(text)),
    proposals: dialogProposals,
    record: (type, data) => kernel.log.info(type, data),
  });

  // A flag is announced when it first appears (not on every sweep that still sees it).
  let flagged = new Set<string>();
  const announce = (view: WardenRunView): void => {
    const now = new Set<string>();
    for (const anomaly of wardenFlags(view)) {
      const key = `${anomaly.sessionId}|${anomaly.kind}`;
      now.add(key);
      if (!flagged.has(key))
        kernel.events.publish(WardenFlagged, { ferret: anomaly.sessionId as FerretId, kind: anomaly.kind });
    }
    flagged = now;
  };

  // The loop drives the service through its own wrapper so a timer tick and a manual run share one chain.
  const loop = new WardenSweepLoop(
    {
      run: async options => {
        const view = await service.run(options);
        announce(view);
        return view;
      },
      intervalMs: async () => await service.intervalMs(),
    },
    {
      every: (intervalMs, tick) => kernel.clock.every(milliseconds(intervalMs), tick),
      after: (delayMs, action) => kernel.clock.after(milliseconds(delayMs), action),
      nowMs,
    },
  );

  return {
    status: async scope => {
      const due = loop.nextDueAtMs();
      return await service.status(due === undefined ? undefined : isoFromMs(due), scope);
    },
    verdicts: async scope => await reader.readVerdicts(undefined, scope),
    report: async reportPath => await reader.readReportAt(posix.join(REPORTS_DIRECTORY, posix.basename(reportPath))),
    run: async spawn => await loop.run(spawn),
    config: async () => naming(await service.view()),
    updateConfig: async (patch, options) => naming(await service.updateConfig(parseWardenConfigPatch(patch), options)),
    nameJevKey: async () => {
      const held = await configStore.nameJevKey();
      const view = naming(await service.view());
      return held.length === 0 ? view : { ...view, held: [...held] };
    },
    agenda: async scope => await service.agenda(scope),
    dialogs: {
      rules: async () => await dialogRulesView(kernel.config, dialogProposals, builtInRules),
      learn: async request => {
        const address = await ferrets.resolve(request.ferret);
        if (address.kind !== 'ferret')
          throw new DialogLearnRefused(address.kind === 'ambiguous' ? address.message : `no ferret ${request.ferret}.`);
        return request.confirm === true
          ? await dialogLearn.confirm(address.id)
          : await dialogLearn.learn(address.id, request.row);
      },
    },
    // Queued inside the sweep chain, then a sweep right behind it: if a slot is free the investigation starts now.
    investigate: async (ferret, note) => {
      const queued = await loop.exclusive(async () => await service.requestInvestigation(ferret, note));
      if (queued.state === 'running') return queued;
      await loop.run(false).catch(() => undefined);
      return await service.investigationStatus(ferret);
    },
    leave: async (ferret, duration) => await loop.exclusive(async () => await service.leaveAlone(ferret, duration)),
    launched: ferret => liveness.launched(ferret),
    nudgeSweep: trigger => {
      void service
        .currentConfig()
        .then(config => {
          if (config.enabled && wardenTriggerEnabled(trigger, config.events)) loop.trigger();
        })
        .catch(() => undefined);
    },
    arm: () => {
      let disarm: (() => void) | undefined;
      let stopped = false;
      // The liveness monitor's own tick (today's): one at a time — a slow tick is skipped over, never stacked. A quiet
      // ferret is nudged only while the Warden is on and the owner lets it nudge alone, inside the sweep chain; a ferret
      // that froze brings the next sweep forward. Terminals off: the tick looks at nothing.
      syncLiveness();
      let looking = false;
      const look = async (): Promise<void> => {
        if (looking || stopped) return;
        looking = true;
        try {
          if (!syncLiveness()) return;
          const config = await service.currentConfig();
          // Not allowed to nudge: a frozen verdict does not wait for a nudge that will never come (`reflexAssess`).
          const nudgeAllowed = config.enabled && config.mayActAlone.nudge;
          const events = await liveness.tick({ nudgeAllowed });
          const result = await loop.exclusive(async () => await service.reflex(events));
          if (result.frozen) loop.trigger();
        } catch (error) {
          kernel.log.warn('warden: a liveness tick failed', { error: String(error) });
        } finally {
          looking = false;
        }
      };
      const stopLooking = kernel.clock.every(milliseconds(WARDEN_LIVENESS_TICK_SECONDS * 1000), () => void look());
      // The dialog look: its own tick (the liveness one needs Terminals), one at a time, off with the Warden.
      let dialogLooking = false;
      const lookForDialogs = async (): Promise<void> => {
        if (dialogLooking || stopped) return;
        dialogLooking = true;
        try {
          await dialogWatch.look((await service.currentConfig()).enabled);
        } catch (error) {
          kernel.log.warn('warden: a dialog look failed', { error: String(error) });
        } finally {
          dialogLooking = false;
        }
      };
      const stopDialogs = kernel.clock.every(
        milliseconds(WARDEN_DIALOG_TICK_SECONDS * 1000),
        () => void lookForDialogs(),
      );
      void loop.arm().then(
        off => {
          if (stopped) off();
          else disarm = off;
        },
        error => kernel.log.error('warden: the sweep timer did not start', { error: String(error) }),
      );
      return () => {
        stopped = true;
        stopLooking();
        stopDialogs();
        if (livenessArmed) liveness.disarm();
        livenessArmed = false;
        disarm?.();
        void workFolders.close().catch(() => undefined);
      };
    },
  };
}

function scalars(data: Readonly<Record<string, unknown>>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(data))
    out[key] =
      typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
        ? value
        : JSON.stringify(value);
  return out;
}
