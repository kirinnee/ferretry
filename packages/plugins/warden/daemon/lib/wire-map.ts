/**
 * The sweep computes with today's vocabulary (a session, an anomaly, a task); the routes speak the contract's words
 * (a ferret, a flag, a card). This is the one place the two meet: every view the sweep builds is restated here, field
 * for field, and parsed by the contract's schema on the way out so a drift fails loudly in a test, not in the app.
 */
import {
  WardenAgendaViewSchema,
  type WardenFlag,
  type WardenBlessingView,
  WardenBlessingViewSchema,
  WardenFlagSchema,
  WardenInvestigateViewSchema,
  WardenLeaveViewSchema,
  type WardenRunView,
  WardenRunViewSchema,
  WardenStatusViewSchema,
  WardenVerdictsViewSchema,
} from '../../contract/index.ts';
import type { FerretState } from '@ferretry/core-ferrets/contract';
import type { z } from 'zod';
import type * as Internal from './protocol.ts';
import { wardenFlags } from './protocol.ts';

/** Today's session statuses on the four states a ferret has (§1): what the owner sees is the state. */
export function ferretStateOf(status: Internal.SessionStatus): FerretState {
  switch (status) {
    case 'created':
    case 'starting':
      return 'starting';
    case 'running':
    case 'thinking':
    case 'tool_running':
    case 'retrying':
    case 'rate_limited':
      return 'working';
    case 'awaiting_question':
    case 'awaiting_user':
    case 'interrupted':
    case 'waiting':
      return 'idle';
    case 'completed':
    case 'failed':
    case 'stalled':
    case 'stopped':
    case 'kill_failed':
      return 'stopped';
  }
}

const defined = <T extends Record<string, unknown>>(record: T): T =>
  Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;

export function toWireFlag(anomaly: Internal.WardenAnomaly): WardenFlag {
  return WardenFlagSchema.parse(
    defined({
      kind: anomaly.kind,
      ferret: anomaly.sessionId,
      generation: anomaly.generation,
      provider: anomaly.provider,
      affectedFerrets: anomaly.affectedSessionIds,
      failureClasses: anomaly.failureClasses,
      models: anomaly.models,
      name: anomaly.teammate,
      label: anomaly.label,
      state: ferretStateOf(anomaly.status),
      detail: anomaly.detail,
      since: anomaly.since,
      idleMinutes: anomaly.idleMinutes,
      assignedWarden: anomaly.assignedWarden,
      ledger: anomaly.ledger,
      subject: anomaly.subject,
      card: anomaly.task === undefined ? undefined : { id: anomaly.task.id },
    }),
  );
}

const flagsOf = (view: {
  readonly anomalies: readonly Internal.WardenAnomaly[];
  readonly stuckInput?: readonly Internal.WardenStuckInputFlag[] | undefined;
  readonly stuckInbox?: readonly Internal.WardenStuckInboxFlag[] | undefined;
}): WardenFlag[] => wardenFlags(view).map(toWireFlag);

export function toWireBlessing(blessing: Internal.WardenBlessingView): WardenBlessingView {
  const { sessionId, ...rest } = blessing;
  return WardenBlessingViewSchema.parse({ ferret: sessionId, ...rest });
}

function toWireInvestigation(investigation: Internal.WardenInvestigation): Record<string, unknown> {
  const { targetSession, wardenSession, scope, jev: _jev, ...rest } = investigation;
  return defined({
    ...rest,
    scope: scope === 'session' ? 'ferret' : 'pack',
    target: targetSession,
    warden: wardenSession,
  });
}

function toWireAction(action: Internal.WardenAction): Record<string, unknown> {
  const { sessionId, ...rest } = action;
  return { ferret: sessionId, ...rest };
}

export function toWireStatus(view: Internal.WardenStatusView): WardenStatusView {
  const {
    anomalies: _a,
    stuckInput: _i,
    stuckInbox: _b,
    investigations,
    actions,
    blessings,
    jevChecks,
    ...rest
  } = view;
  return WardenStatusViewSchema.parse({
    ...rest,
    flags: flagsOf(view),
    investigations: investigations.map(toWireInvestigation),
    actions: actions.map(toWireAction),
    blessings: blessings.map(toWireBlessing),
    // A Jev check names the ferret it was about, not the session.
    ...(jevChecks === undefined
      ? {}
      : { jevChecks: jevChecks.map(({ sessionId, ...check }) => ({ ...check, ferret: sessionId })) }),
  });
}

export function toWireRun(view: Internal.WardenRunView): WardenRunView {
  return WardenRunViewSchema.parse(
    defined({
      sweptAt: view.sweptAt,
      flags: flagsOf(view),
      spawned: view.spawned,
      assignedWardens: view.assignedWardens,
      message: view.message,
    }),
  );
}

export function toWireVerdicts(verdicts: readonly Internal.WardenVerdict[]) {
  return WardenVerdictsViewSchema.parse(
    verdicts.map(verdict => {
      const { targetSession, teammate, ...rest } = verdict;
      return defined({ ...rest, target: targetSession, name: teammate });
    }),
  );
}

export function toWireInvestigate(view: Internal.WardenInvestigateView): WardenInvestigateView {
  return WardenInvestigateViewSchema.parse(
    defined({
      ferret: view.sessionId,
      state: view.state,
      position: view.position,
      warden: view.wardenSession,
      message: view.message,
    }),
  );
}

export function toWireLeave(view: Internal.WardenLeaveView): WardenLeaveView {
  return WardenLeaveViewSchema.parse({ blessing: toWireBlessing(view.blessing), message: view.message });
}

const AGENDA_SOURCE: Readonly<Record<Internal.FleetAgendaItem['source'], string>> = {
  task: 'card',
  question: 'question',
  'agent-raised': 'agent-raised',
  'warden-anomaly': 'warden-flag',
  'warden-action': 'warden-action',
};

export function toWireAgenda(view: Internal.WardenAgendaView): WardenAgendaView {
  return WardenAgendaViewSchema.parse(
    defined({
      generatedAt: view.generatedAt,
      lastSweepAt: view.lastSweepAt,
      outcome: view.outcome,
      wardenDegraded: view.wardenDegraded,
      verdictCoverage: view.verdictCoverage,
      items: view.items.map(item => {
        const { sessionId, teammate, sessionStatus, source, fromAnomaly, judgement, ...rest } = item;
        return defined({
          ...rest,
          ferret: sessionId,
          name: teammate,
          ferretState: sessionStatus === undefined ? undefined : ferretStateOf(sessionStatus),
          source: AGENDA_SOURCE[source],
          fromFlag: fromAnomaly,
          judgement:
            judgement === undefined
              ? undefined
              : defined({
                  ...judgement,
                  judgedBy:
                    judgement.judgedBy === undefined
                      ? undefined
                      : defined({
                          ...judgement.judgedBy,
                          warden: judgement.judgedBy.wardenSessionId,
                          wardenSessionId: undefined,
                        }),
                }),
        });
      }),
    }),
  );
}

type WardenAgendaView = z.infer<typeof WardenAgendaViewSchema>;
type WardenInvestigateView = z.infer<typeof WardenInvestigateViewSchema>;
type WardenLeaveView = z.infer<typeof WardenLeaveViewSchema>;
type WardenStatusView = z.infer<typeof WardenStatusViewSchema>;
