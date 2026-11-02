import type { AgendaId, AgendaItem, AgendaSnapshot } from '@ferretry/protocol';
import type { AgendaActor } from './state-machine.ts';

const DAEMON: AgendaActor = { kind: 'daemon', cause: 'system' };

const AUTO_MOVE_REF = 'warden-auto-migrate';
const ORPHAN_PREFIX = 'warden-orphan:';
const BUDGET_PREFIX = 'budget:';

/** Where the one-time folding records that it ran: once, for this daemon's home. */
export interface MachineMigrationMarker {
  ran(): Promise<boolean>;
  record(at: string, closed: readonly string[]): Promise<void>;
}

/** What the old per-ferret items are carried into: the machine items that now hold each cause. */
export interface MachineSeed {
  autoMoveFailed(sessionId: string, item: AgendaItem): Promise<void>;
  orphan(item: AgendaItem): Promise<void>;
  budget(sourceRef: string, item: AgendaItem): Promise<void>;
}

export interface MachineMigrationPorts {
  readonly agenda: {
    list(sessionId: string): Promise<{ readonly ok: true; readonly value: AgendaSnapshot } | { readonly ok: false }>;
    resolve(sessionId: string, id: AgendaId, actor: AgendaActor, note: string): Promise<{ readonly ok: boolean }>;
  };
  readonly sessions: { all(): Promise<readonly string[]> };
  readonly seed: MachineSeed;
  readonly marker: MachineMigrationMarker;
  readonly now: () => string;
  readonly diagnostics: { warn(message: string): void };
}

const NOTE = 'folded into the machine agenda, where this cause is one item';

/**
 * THE ONE-TIME FOLDING (docs/agenda.md § The machine agenda): before the machine agenda, an auto-move failure, an
 * orphaned card and a hard-limit notice were each raised on a ferret's own agenda, so they piled up. Every open one is
 * carried into its machine item (the same cause lands on the same item, so duplicates keep one) and closed where it
 * was raised. The marker is written only when every agenda was read and every item folded; a start that finds it
 * does nothing, and a failed one is tried again next start. The seeds are quiet (no push for an old notice), and a
 * budget notice whose window already reset is closed without a machine item.
 */
export async function foldNoticesIntoMachineAgenda(ports: MachineMigrationPorts): Promise<void> {
  if (await ports.marker.ran()) return;
  let complete = true;
  const closed: string[] = [];
  for (const sessionId of await ports.sessions.all()) {
    const listed = await ports.agenda.list(sessionId).catch(() => undefined);
    if (listed === undefined || !listed.ok) {
      complete = false;
      continue;
    }
    for (const item of listed.value.items) {
      const ref = item.sourceRef;
      if (ref === null || ref === undefined) continue;
      const folded = await fold(ports, sessionId, ref, item).catch(() => false);
      if (!folded) {
        if (isCause(ref)) complete = false;
        continue;
      }
      const resolved = await ports.agenda.resolve(sessionId, item.id, DAEMON, NOTE).catch(() => undefined);
      if (resolved?.ok === true) closed.push(`${sessionId} !${item.id}`);
      else complete = false;
    }
  }
  if (complete) await ports.marker.record(ports.now(), closed);
  else
    ports.diagnostics.warn('the folding of notices into the machine agenda is unfinished; the next start tries again');
}

const isCause = (ref: string): boolean =>
  ref === AUTO_MOVE_REF || ref.startsWith(ORPHAN_PREFIX) || ref.startsWith(BUDGET_PREFIX);

/** The window a budget ref names ends at its trailing ISO instant; a ref without one is treated as still open. */
const budgetWindowEnded = (ref: string, nowMs: number): boolean => {
  const end = /\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.exec(ref)?.[0];
  return end !== undefined && Date.parse(end) <= nowMs;
};

async function fold(ports: MachineMigrationPorts, sessionId: string, ref: string, item: AgendaItem): Promise<boolean> {
  const { seed } = ports;
  if (ref === AUTO_MOVE_REF) await seed.autoMoveFailed(sessionId, item);
  else if (ref.startsWith(ORPHAN_PREFIX)) await seed.orphan(item);
  else if (ref.startsWith(BUDGET_PREFIX)) {
    // A window that already reset has nothing left to tell: the old item is closed and no machine item is made.
    if (!budgetWindowEnded(ref, Date.parse(ports.now()))) await seed.budget(ref, item);
  } else return false;
  return true;
}
