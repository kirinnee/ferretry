import { posix } from 'node:path';
import { milliseconds } from '@ferretry/std';
import type { AsksApi } from '@ferretry/core-asks/contract';
import type { FerretId, FerretsApi } from '@ferretry/core-ferrets/contract';
import type { KernelPorts } from '@ferretry/kernel/contract';
import type { BoardApi } from '@ferretry/plugin-board/contract';
import type { BrowsersApi } from '@ferretry/plugin-browsers/contract';
import type { ConversationApi } from '@ferretry/plugin-conversation/contract';
import type { TerminalsApi } from '@ferretry/plugin-terminals/contract';
import type { UsageHeadroomApi } from '../contract/others.ts';
import { WARDEN_CONFIG, WardenActed, WardenConfigChanged, WardenFlagged } from '../contract/index.ts';
import { AsksWardenAgenda, NoticeEntries } from './asks.ts';
import { boardReader } from './board.ts';
import {
  ConfigWardenConfigStore,
  FileWardenArtifacts,
  StateWardenJevCheckLog,
  StateWardenReportFiles,
  StateWardenStateStore,
  WardenReportReader,
} from './adapters/index.ts';
import {
  exchangeSends,
  livenessTargets,
  readFleet,
  reviveEventsOf,
  TurnOrdinals,
  transcriptDigest,
  withLiveness,
} from './fleet.ts';
import { createWardenRemedies } from './remedies.ts';
import {
  type LivenessSample,
  type WardenAgentInventory,
  WardenLivenessMonitor,
  WardenReviveService,
  WardenSweepLoop,
  WardenSweepService,
  type WardenSpawner,
  wardenTriggerEnabled,
} from './lib/index.ts';
import { parseWardenConfigPatch } from './lib/config.ts';
import { JevTriageGuard } from './lib/jev.ts';
import type { OutboundAuthorizerPort } from './lib/jev-ports.ts';
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
  /** Board, when it is on: read at each sweep, never during build. */
  readonly board: () => BoardApi | undefined;
  /** Terminals, when it is on: the liveness look at each ferret's own pane. Off, the liveness checks do not run. */
  readonly terminals?: () => TerminalsApi | undefined;
  /** Browsers, when it is on: it closes the browsers left under a ferret's pane. Off, that check does not run. */
  readonly browsers?: () => BrowsersApi | undefined;
}

/** What the routes serve (today's `WardenSubsystem`, in the contract's words where they differ). */
export interface WardenSubsystem {
  status(): Promise<WardenStatusView>;
  verdicts(): Promise<readonly WardenVerdict[]>;
  report(reportPath: string): Promise<string | undefined>;
  run(spawn: boolean): Promise<WardenRunView>;
  config(): ReturnType<WardenSweepService['view']>;
  updateConfig(patch: unknown): ReturnType<WardenSweepService['updateConfig']>;
  agenda(): Promise<WardenAgendaView>;
  investigate(ferret: string, note?: string): Promise<WardenInvestigateView>;
  leave(ferret: string, duration: '1h' | '4h' | 'until_change'): ReturnType<WardenSweepService['leaveAlone']>;
  /** An event that may bring the next sweep forward (a turn ended, a ferret stopped). */
  nudgeSweep(trigger: 'turnEnd' | 'question' | 'paneDied'): void;
  arm(): () => void;
}

/**
 * THE SEAM THAT KEEPS "NO UNATTENDED SPEND BY SURPRISE": the Jev guard is today's `JevTriageGuard`, but it spends the Jev
 * key only through an outbound authorizer. GAP(kernel): the key is read through the kernel's `secrets.resolve`
 * (OwnSecret, D2 #19), which `KernelPorts` does not carry on 5.0; the manifest already declares `secrets:
 * ['JEV_API_KEY']` and the `api.typesafe.ai` network. Until it does, every call answers `secret_missing`, which the guard
 * turns into `not_set`: no request leaves the machine and nothing is spent.
 */
const NO_VAULT: OutboundAuthorizerPort = { send: async () => ({ kind: 'secret_missing' }) };

/** A turn's wall-clock is the kernel's: monotonic time for the guard's latency. */
const stopwatch = { monotonicMs: (): number => performance.now() };

/** How often the liveness monitor looks at every working ferret: kteam's own tick (today's). */
export const WARDEN_LIVENESS_TICK_SECONDS = 30;

/** The binary's name, for sentences that name a command a ferret types; the other halves quote it the same way. */
const BINARY = 'fy';

const refuse = (what: string): never => {
  throw new Error(`${what} is not available on this machine yet.`);
};

export function createWardenSubsystem(host: WardenHost): WardenSubsystem {
  const { kernel, ferrets, conversation, asks } = host;
  const nowMs = (): number => kernel.clock.nowMs();
  const turns = new TurnOrdinals();
  const entries = new NoticeEntries();
  const agenda = new AsksWardenAgenda(asks, entries);
  const files = new StateWardenReportFiles(kernel.state);
  const reader = new WardenReportReader(files, REPORTS_DIRECTORY);
  const artifacts = new FileWardenArtifacts(files, reader, REPORTS_DIRECTORY);
  const configStore = new ConfigWardenConfigStore(kernel.config);
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
    sleep: async ms =>
      await new Promise<void>(resolve => {
        kernel.clock.after(milliseconds(ms), resolve);
      }),
    notifyOwner: async notice => {
      // The breaker's one notice lands on the ferret that tripped it, as a plain notification (today's).
      await agenda.notice(notice.sessionId, {
        sourceRef: 'warden-revive-breaker',
        subject: `${notice.title}: ${notice.subject}`,
        why: notice.why,
        context: 'Auto-revive paused itself after revived sessions kept dying.',
        howToResolve:
          'Nothing to answer. Look at why sessions keep dying; revives resume by themselves after the pause.',
      });
    },
    journal: { record: (type, data) => kernel.log.info(type, scalars(data)) },
  });

  // ── investigators ────────────────────────────────────────────────────────────────────────────────────────────────────
  // GAP(warden folder): Ferrets now starts a ferret in a `workFolder` and hands back what it wrote with
  // `summary(ferret)`, but the Warden has no folder of its own to pass: its manifest declares no root and the kernel
  // offers no path to its state. Without one, no investigator starts and nothing is spent.
  const spawner: WardenSpawner = {
    spawn: async request => {
      if (request.cwd === '') {
        return refuse('Starting a warden investigation (it has no folder to work and write its report in)');
      }
      return refuse('Starting a warden investigation');
    },
  };

  const agents: WardenAgentInventory = {
    installed: async () => ferrets.harnesses(),
    currentName: async reference => reference,
    defaultRuntime: async () => undefined,
  };

  const service = new WardenSweepService(
    {
      orphans: {
        // An orphaned card's notice stands on one ferret's board as an ask, exactly as the revive breaker's does. An
        // Agenda that refuses it makes the sweep journal `fleet.warden_orphan_failed` and try again, nothing remembered.
        add: async (sessionId, notice) => {
          const written = await agenda.notice(sessionId, {
            sourceRef: notice.sourceRef,
            subject: notice.subject,
            why: notice.why,
            context: `${notice.premise}\n${notice.context}`,
            howToResolve: notice.howToResolve,
          });
          if (written === 'rejected') throw new Error('the Agenda refused the orphaned-card notice');
        },
        remove: async resolution => {
          await agenda.resolveSource(resolution.sessionId, 'agent-raised', resolution.sourceRef, resolution.note);
        },
      },
      guard: () => new JevTriageGuard(NO_VAULT, stopwatch),
      evidence: { evidence: async () => ({ recentTurns: [] }) },
      redactor: { batch: async work => await kernel.redaction.read(scope => work({ text: text => scope.text(text) })) },
      remedies,
      costs: { costUsd: async () => undefined },
      feed: { board: async ferret => await agenda.feed(ferret) },
      fleet: {
        fleet: async () => {
          const fleet = await fleetNow();
          if (!monitorOn()) return fleet;
          const now = isoFromMs(nowMs());
          const leftovers = browsers() !== undefined;
          return fleet.map(session => withLiveness(session, liveness, now, leftovers));
        },
        // A monitor that has stopped seeing is ONE fault of this daemon, never one per ferret.
        monitorStalled: () => monitorOn() && liveness.stalled(),
      },
      spawner,
      artifacts,
      state: new StateWardenStateStore(kernel.state),
      config: configStore,
      agents,
      usage: { accounts: async () => [] },
      verdicts: { recent: async () => await reader.readVerdicts().catch(() => undefined) },
      attention: agenda,
      journal: { record: (type, data) => kernel.log.info(type, scalars(data)) },
      jevChecks: new StateWardenJevCheckLog(kernel.state, nowMs),
      revive,
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
    status: async () => {
      const due = loop.nextDueAtMs();
      return await service.status(due === undefined ? undefined : isoFromMs(due));
    },
    verdicts: async () => await reader.readVerdicts(),
    report: async reportPath => await reader.readReportAt(posix.join(REPORTS_DIRECTORY, posix.basename(reportPath))),
    run: async spawn => await loop.run(spawn),
    config: async () => await service.view(),
    updateConfig: async patch => await service.updateConfig(parseWardenConfigPatch(patch)),
    agenda: async () => await service.agenda(),
    // Queued inside the sweep chain, then a sweep right behind it: if a slot is free the investigation starts now.
    investigate: async (ferret, note) => {
      const queued = await loop.exclusive(async () => await service.requestInvestigation(ferret, note));
      if (queued.state === 'running') return queued;
      await loop.run(false).catch(() => undefined);
      return await service.investigationStatus(ferret);
    },
    leave: async (ferret, duration) => await loop.exclusive(async () => await service.leaveAlone(ferret, duration)),
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
        if (livenessArmed) liveness.disarm();
        livenessArmed = false;
        disarm?.();
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
