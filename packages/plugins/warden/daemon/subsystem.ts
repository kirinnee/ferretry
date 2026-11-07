import { posix } from 'node:path';
import { milliseconds } from '@ferretry/std';
import type { AsksApi } from '@ferretry/core-asks/contract';
import type { FerretId, FerretsApi } from '@ferretry/core-ferrets/contract';
import type { KernelPorts } from '@ferretry/kernel/contract';
import type { ConversationApi } from '@ferretry/plugin-conversation/contract';
import type { UsageHeadroomApi } from '../contract/others.ts';
import { WardenActed, WardenFlagged } from '../contract/index.ts';
import { AsksWardenAgenda, NoticeEntries } from './asks.ts';
import {
  ConfigWardenConfigStore,
  FileWardenArtifacts,
  StateWardenJevCheckLog,
  StateWardenReportFiles,
  StateWardenStateStore,
  WardenReportReader,
} from './adapters/index.ts';
import { exchangeSends, readFleet, TurnOrdinals } from './fleet.ts';
import { createWardenRemedies } from './remedies.ts';
import {
  type WardenAgentInventory,
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
export const REPORTS_DIRECTORY = 'reports';

/** What the warden needs of the rest of the daemon: ports it was handed, and the optional Usage. */
export interface WardenHost {
  readonly kernel: KernelPorts;
  readonly ferrets: FerretsApi;
  readonly conversation: ConversationApi;
  readonly asks: AsksApi;
  readonly usage: () => UsageHeadroomApi | undefined;
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
 * key only through an outbound authorizer, and Warden does not `need` the Vault (its manifest declares `secrets:
 * ['JEV_API_KEY']` and no Vault port). Until the Vault is wired in, every call answers `secret_missing`, which the guard
 * turns into `not_set`: no request leaves the machine and nothing is spent.
 */
const NO_VAULT: OutboundAuthorizerPort = { send: async () => ({ kind: 'secret_missing' }) };

/** A turn's wall-clock is the kernel's: monotonic time for the guard's latency. */
const stopwatch = { monotonicMs: (): number => performance.now() };

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

  const acted = (ferret: string, action: string, outcome: 'done' | 'failed'): void =>
    kernel.events.publish(WardenActed, { ferret: ferret as FerretId, action, outcome });
  // ── the remedies: every one goes through Ferrets or Conversation, never around them (`remedies.ts`) ──────────────
  const { remedies, resume: automaticResume } = createWardenRemedies({ ferrets, conversation, asks, acted });

  // ── auto-revive: today's default-on revive, resuming through Ferrets under today's automatic refusals ─────────────
  // It revives only a ferret that DIED (status `failed`, its journal ending in an abnormal exit: `classifyEnd`).
  // GAP(ferrets): 5.0's `FerretSummary` carries no death cause (four states, no exit status or signal), so no ferret
  // reads as failed and nothing is revived until Ferrets adds one. The breaker, the per-day caps and the owner's
  // `mayActAlone.resume` still govern it when it can act.
  const revive = new WardenReviveService({
    events: {
      read: async () => [],
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
  // A report is a file the investigating ferret writes; it needs a folder Ferrets may start it in AND the daemon can read
  // back, and the host gives the warden none yet. Without one, no investigator starts and nothing is spent (GAP).
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
      orphans: { add: async () => undefined, remove: async () => undefined },
      guard: () => new JevTriageGuard(NO_VAULT, stopwatch),
      evidence: { evidence: async () => ({ recentTurns: [] }) },
      redactor: { batch: async work => await kernel.redaction.read(scope => work({ text: text => scope.text(text) })) },
      remedies,
      costs: { costUsd: async () => undefined },
      feed: { board: async ferret => await agenda.feed(ferret) },
      fleet: {
        fleet: async () => await readFleet(ferrets, conversation, asks, turns, ferret => `ferrets/${ferret}`),
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
      // The send ledgers, for a sub-ferret overdue on a report its parent asked for (a flag and a notice, no act).
      exchanges: { sends: async ferret => await exchangeSends(conversation, ferret as FerretId) },
      nowMs,
      capabilities: () => `${crypto.randomUUID()}${crypto.randomUUID().replaceAll('-', '')}`,
    },
    {
      clientName: 'Ferretry',
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
      void loop.arm().then(
        off => {
          if (stopped) off();
          else disarm = off;
        },
        error => kernel.log.error('warden: the sweep timer did not start', { error: String(error) }),
      );
      return () => {
        stopped = true;
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
