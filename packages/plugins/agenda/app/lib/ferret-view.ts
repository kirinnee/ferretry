/**
 * A FERRET, as the Agenda draws it: who it is (its id, name, label, card and lineage) and whether something waits on
 * the owner (its agenda summary). Today the shell's fleet list carried both, the summary as `state.agenda`. Here the
 * two come from their owners through this half's client: the ferret from Ferrets' list (`GET /v1/ferrets`, a need of
 * Agenda), the summary from Agenda's own roll-up of every ferret's open and parked items (`GET /v1/agenda/open`),
 * built with the daemon's own rule (`agendaSummaryOf`, copied from today's `sessionAgendaSummary`).
 */

import { type SessionAgendaSummary } from '../../contract/wire.ts';
import { type FerretEndCause, FerretEndCauseSchema } from '@ferretry/core-ferrets/contract';
import type { AgendaItem, TaskRef } from '@ferretry/core-asks/contract';
import { needsYouQueue } from './agenda-queue.ts';

/** Where a ferret stands (Ferrets' four states), and `running` for the machine's own stand-in conversation. */
export type FerretStatus = 'starting' | 'working' | 'idle' | 'stopped' | 'running';

export interface FerretConfig {
  readonly id: string;
  /** What it works on (Ferrets' `title`). */
  readonly name?: string;
  readonly label?: string;
  /** The ferret's callsign (Ferrets' `name`). */
  readonly teammate?: string;
  readonly parent?: string;
  readonly projectId?: string;
  /** The card the ferret works on. */
  readonly focusTask?: TaskRef;
  readonly mode?: 'auto' | 'interactive';
  readonly cwd?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface FerretState {
  readonly id?: string;
  readonly status: FerretStatus;
  readonly reason?: string;
  readonly lastActivityAt?: string;
  readonly turn?: number;
  /** Why a stopped ferret ended (Ferrets' end cause); only ever present while `status` is `stopped`. */
  readonly cause?: FerretEndCause;
  /** The open agenda items waiting on the owner; absent when none is open. */
  readonly agenda?: SessionAgendaSummary;
}

export interface FerretView {
  readonly config: FerretConfig;
  readonly state: FerretState;
}

/** Each ferret's root view by ferret id: a ferret with no parent in `views` is its own root. */
export const rootViews = (views: readonly FerretView[]): ReadonlyMap<string, FerretView> => {
  const byId = new Map(views.map(view => [view.config.id, view] as const));
  const roots = new Map<string, FerretView>();
  for (const view of views) {
    const seen = new Set<string>([view.config.id]);
    let root = view;
    for (;;) {
      const parent = root.config.parent === undefined ? undefined : byId.get(root.config.parent);
      if (parent === undefined || seen.has(parent.config.id)) break;
      seen.add(parent.config.id);
      root = parent;
    }
    roots.set(view.config.id, root);
  }
  return roots;
};

const inDiscussion = (item: Pick<AgendaItem, 'waitingOn' | 'waitingFor'>): boolean =>
  item.waitingOn !== undefined && item.waitingFor === 'discussion';

/**
 * A ferret's open-items summary from its items, as the daemon builds `state.agenda` (today's `sessionAgendaSummary`
 * and `decoratedSummary`): a parked item or a notice waits on nobody; an idle ferret with an item on the owner's turn
 * is stopped on the owner.
 */
export const agendaSummaryOf = (
  items: readonly AgendaItem[],
  status?: FerretStatus,
): SessionAgendaSummary | undefined => {
  const open = items.filter(item => item.notice !== true && item.parked === undefined);
  const [oldest] = open;
  if (oldest === undefined) return undefined;
  const first = open.find(item => !inDiscussion(item)) ?? oldest;
  const latestAt = open.reduce(
    (latest, item) => (item.waitingSince.localeCompare(latest) > 0 ? item.waitingSince : latest),
    oldest.waitingSince,
  );
  const discussing = open.filter(inDiscussion).length;
  return {
    open: open.length,
    first: first.id,
    ask: first.subject,
    latestAt,
    ...(discussing === 0 ? {} : { discussing }),
    ...(status === 'idle' && needsYouQueue(items).length > 0 ? { stopped: true as const } : {}),
  };
};

/** A row of Ferrets' list, as far as the Agenda reads it (parsed loosely: any other field is ignored). */
export interface ListedFerret {
  readonly id: string;
  /** The task title (Ferrets' `title`). */
  readonly name?: string;
  /** The callsign (Ferrets' `name`). */
  readonly teammate?: string;
  readonly label?: string;
  readonly parent?: string;
  readonly projectId?: string;
  readonly card?: string;
  readonly mode?: 'auto' | 'interactive';
  readonly folder?: string;
  readonly state?: string;
  readonly stateAt?: string;
  /** Why it ended, when it is stopped (Ferrets' `cause`); a value that is not an end cause is dropped. */
  readonly cause?: FerretEndCause;
  readonly createdAt?: string;
}

const STATUSES: ReadonlySet<string> = new Set(['starting', 'working', 'idle', 'stopped']);

const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

/** Ferrets' list answer, row by row; a row with no id is dropped. */
export const parseFerretList = (value: unknown): readonly ListedFerret[] => {
  const rows = Array.isArray(value)
    ? value
    : Array.isArray((value as { ferrets?: unknown } | null)?.ferrets)
      ? (value as { ferrets: unknown[] }).ferrets
      : [];
  return rows.flatMap(row => {
    if (typeof row !== 'object' || row === null) return [];
    const fields = row as Record<string, unknown>;
    const id = text(fields.id);
    if (id === undefined) return [];
    const cause = FerretEndCauseSchema.safeParse(fields.cause);
    const mode = fields.mode === 'auto' || fields.mode === 'interactive' ? fields.mode : undefined;
    const optional = {
      name: text(fields.title),
      teammate: text(fields.name),
      label: text(fields.label),
      parent: text(fields.parent),
      projectId: text(fields.projectId),
      card: text(fields.card),
      folder: text(fields.folder),
      state: text(fields.state),
      stateAt: text(fields.stateAt),
      createdAt: text(fields.createdAt),
    };
    return [
      {
        id,
        ...Object.fromEntries(Object.entries(optional).filter(([, entry]) => entry !== undefined)),
        ...(mode === undefined ? {} : { mode }),
        ...(cause.success ? { cause: cause.data } : {}),
      } as ListedFerret,
    ];
  });
};

/** One ferret's view: its identity from Ferrets, its summary from its items. */
const ferretView = (ferret: ListedFerret, items: readonly AgendaItem[]): FerretView => {
  const status: FerretStatus =
    ferret.state !== undefined && STATUSES.has(ferret.state) ? (ferret.state as FerretStatus) : 'idle';
  const agenda = agendaSummaryOf(items, status);
  const config: FerretConfig = {
    id: ferret.id,
    ...(ferret.name === undefined ? {} : { name: ferret.name }),
    ...(ferret.teammate === undefined ? {} : { teammate: ferret.teammate }),
    ...(ferret.label === undefined ? {} : { label: ferret.label }),
    ...(ferret.parent === undefined ? {} : { parent: ferret.parent }),
    ...(ferret.projectId === undefined ? {} : { projectId: ferret.projectId }),
    ...(ferret.card === undefined ? {} : { focusTask: { id: ferret.card } as TaskRef }),
    ...(ferret.mode === undefined ? {} : { mode: ferret.mode }),
    ...(ferret.folder === undefined ? {} : { cwd: ferret.folder }),
    ...(ferret.createdAt === undefined ? {} : { createdAt: ferret.createdAt }),
  };
  return {
    config,
    state: {
      id: ferret.id,
      status,
      ...(ferret.stateAt === undefined ? {} : { lastActivityAt: ferret.stateAt }),
      ...(status === 'stopped' && ferret.cause !== undefined ? { cause: ferret.cause } : {}),
      ...(agenda === undefined ? {} : { agenda }),
    },
  };
};

/**
 * Every ferret of the machine with its summary. A ferret the roll-up names that Ferrets' list does not (it was read a
 * moment apart) is still listed, by its id, so an open item is never dropped for want of a name.
 */
export const ferretViews = (
  ferrets: readonly ListedFerret[],
  boards: ReadonlyMap<string, readonly AgendaItem[]>,
): readonly FerretView[] => {
  const listed = new Set(ferrets.map(ferret => ferret.id));
  return [
    ...ferrets.map(ferret => ferretView(ferret, boards.get(ferret.id) ?? [])),
    ...[...boards]
      .filter(([id, items]) => !listed.has(id) && items.length > 0)
      .map(([id, items]) => ferretView({ id }, items)),
  ];
};
