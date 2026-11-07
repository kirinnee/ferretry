/**
 * THE ONE SEAM to the app shell (GAP(app-shell)). Every file of this half takes what the shell owns — its UI kit and
 * hooks, the paired-daemon list, the router, the settings and account catalogs and the ferret shapes — from here and
 * from nowhere else. A plugin half may not import the app package (`context-imports`) and the shell offers a plugin
 * half none of this yet, so until it does the names below are placeholders that say so when used (the `missing` ones),
 * plus a few small pure helpers copied from the shell unchanged so the half's pure code runs and tests on its own.
 * The shell fills it by re-exporting, and nothing else in this half changes.
 */

import { displaySystemCallsign } from './wire.ts';

type Primitive = (...args: Opaque[]) => Opaque;

/**
 * A shell type this half only passes along or reads a field of. The shell's real types replace these when it exposes
 * them; until then a field read is unchecked, which is why each is named for what it stands for.
 */
// biome-ignore lint/suspicious/noExplicitAny: a placeholder for a shell-owned type, replaced when the shell exposes it
export type Opaque = any;

/**
 * What the shell has not lent this half yet. A name below is a stand-in that delegates to the part the shell hands
 * over through `provideShell` (the shell, or a test with a simple stand-in), and says so when it was handed none.
 */
const provided = new Map<string, Primitive>();

export const provideShell = (parts: Readonly<Record<string, Primitive>>): void => {
  for (const [name, part] of Object.entries(parts)) provided.set(name, part);
};

const missing =
  (name: string): Primitive =>
  (...args) => {
    const part = provided.get(name);
    if (part === undefined) throw new Error(`The app shell does not provide ${name} to plugin halves yet.`);
    return part(...args);
  };

// ─── the clock ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The one clock this half reads and waits on (banned-globals: no bare `Date.now`, `setTimeout` or `setInterval` in a
 * half). The shell replaces it with its kernel clock; this stand-in uses no banned global: the wall clock from the
 * performance timeline, and timers from an abort signal's timeout.
 */
export interface ShellClock {
  /** Epoch milliseconds now. */
  readonly nowMs: () => number;
  /** Runs `run` once after `ms`; calling the answer cancels it. */
  readonly after: (run: () => void, ms: number) => () => void;
  /** Runs `run` every `ms` until the answer is called. */
  readonly every: (run: () => void, ms: number) => () => void;
}

const clockAfter = (run: () => void, ms: number): (() => void) => {
  const signal = AbortSignal.timeout(Math.max(0, ms));
  const fire = (): void => run();
  signal.addEventListener('abort', fire, { once: true });
  return () => signal.removeEventListener('abort', fire);
};

export const shellClock: ShellClock = {
  nowMs: () => Math.round(performance.timeOrigin + performance.now()),
  after: clockAfter,
  every: (run, ms) => {
    let cancel = (): void => undefined;
    let stopped = false;
    const arm = (): void => {
      cancel = clockAfter(() => {
        if (stopped) return;
        run();
        arm();
      }, ms);
    };
    arm();
    return () => {
      stopped = true;
      cancel();
    };
  },
};

// ─── UI primitives, components and hooks ──────────────────────────────────────────────────────────────────────────

export const AnalyticsMetricChart: Primitive = missing('AnalyticsMetricChart');
export const Markdown: Primitive = missing('Markdown');
export const ModelSelect: Primitive = missing('ModelSelect');

/** The width of the Insights column the Warden page shares with Analytics and Learning. */
export const INSIGHTS_COLUMN_CLASS = 'w-full max-w-[1080px]';

// ─── shell data: paired daemons, ferrets, settings and catalogs ──────────────────────────────────────────────────

export type DaemonId = string & { readonly daemonId: unique symbol };

export interface DaemonConnection {
  readonly daemonId: DaemonId;
  readonly baseUrl: string;
  /** Which grant this browser holds on the daemon. An identity, not a credential. */
  readonly deviceId: string;
  readonly daemonName?: string;
  /** The daemon's published carrier set, cached in the order the protocol tries it. */
  readonly carriers: readonly unknown[];
}

export interface DaemonConnectionInput {
  daemonId: string;
  baseUrl: string;
  deviceId: string;
  daemonName?: string | undefined;
  carriers?: readonly unknown[] | undefined;
}

const requireNonEmpty = (value: string, name: string): string => {
  if (value.trim() === '') throw new Error(`${name} must not be empty`);
  return value;
};

/** An immutable connection from pairing output; the direct address stands in when no carrier set was given. */
export const daemonConnection = (input: DaemonConnectionInput): DaemonConnection => {
  const baseUrl = new URL(input.baseUrl).origin;
  const name = input.daemonName?.trim() || undefined;
  return {
    daemonId: requireNonEmpty(input.daemonId, 'daemonId') as DaemonId,
    baseUrl,
    deviceId: requireNonEmpty(input.deviceId, 'deviceId'),
    ...(name === undefined ? {} : { daemonName: name }),
    carriers:
      input.carriers === undefined || input.carriers.length === 0
        ? [{ kind: 'direct', daemonUrl: baseUrl }]
        : input.carriers,
  };
};

/** One ferret as the shell lists it: its config (id, name, folder) and its state. */
export type FerretView = Opaque;
/** The device-local record of what this browser remembers (the daemon the Warden page is narrowed to). */
export type DaemonControlsStore = Opaque;
/** One login and its models as the account picker offers them. */
export type PickerAccount = Opaque;
/** The Speed-ups description of a machine, as the settings read it. */
export type SpeedupsView = Opaque;
/** The context a ferret action runs in. */
export type CoreActionContext = Opaque;
/** An action offered on a ferret, and the host its form opens in. */
export interface FerretActionContribution<Context = Opaque> {
  readonly group: string;
  readonly order: number;
  readonly build: (context: Context) => Opaque | null;
}
export type FerretActionFormHost = Opaque;
export type MetricChartTone = 'accent' | 'ok' | 'pend' | 'info';
export interface MetricChartSeries {
  readonly key: string;
  readonly label: string;
  readonly tone: MetricChartTone;
}
export interface MetricChartPoint {
  /** Unique within the chart: a day, a week or a group's value. */
  readonly key: string;
  /** The x-axis label. */
  readonly label: string;
  /** One value per series, in the series' order, in display units. */
  readonly values: readonly number[];
  /** One reading per series, for a value that reads as more than its number ("unknown", "≥ $5.00"). */
  readonly texts?: readonly string[];
  /** The value is a lower bound: drawn with a hatched cap. */
  readonly flagged?: boolean;
  /** A known zero — nothing happened — drawn as a hairline. */
  readonly empty?: boolean;
  /** The hover readout; defaults to "label · total". */
  readonly readout?: string;
}

/**
 * The grants the Gate shows this device, as far as the Warden reads them: whether `warden.use` is open and, when it
 * is not, why. The shell hands the Gate's own view; only these fields are read.
 */
export interface GrantsView {
  readonly capabilities: readonly {
    readonly capability: string;
    readonly use: boolean;
    readonly useRefusal?: string;
  }[];
}

export const readGrants: Primitive = missing('readGrants');
export const readSpeedups: Primitive = missing('readSpeedups');
export const readAccountPickerCatalog: Primitive = missing('readAccountPickerCatalog');
export const useConfigChangeEffect: Primitive = missing('useConfigChangeEffect');
/** The plugin client of another paired daemon, or the one this half was handed for the daemon on screen. */
export const pluginClientFor: Primitive = missing('pluginClientFor');

// ─── how a ferret is named ────────────────────────────────────────────────────────────────────────────────────────

/** What a ferret config carries that the Warden names it by: its callsign, the task it was given, its folder. */
export interface TitledConfig {
  readonly id: string;
  readonly name?: string | null;
  readonly task?: string | null;
  readonly cwd?: string | null;
}

/** The ferret's one-line name: its callsign, else its task, else its id. */
export const ferretDisplayName = (ferret: { readonly config: TitledConfig }): string => {
  const { config } = ferret;
  const named = displayCallsign(config.name) || (config.task ?? '').trim() || config.id;
  return displaySystemCallsign(named);
};

const baseName = (path: string): string => path.replace(/\/+$/u, '').split('/').pop() ?? '';

/** The title a row shows (what the ferret is doing, else its folder, else its callsign) and the callsign beside it. */
export const ferretTitles = (config: TitledConfig): { readonly title: string; readonly ferret: string | null } => {
  const callsign = displayCallsign(config.name);
  const task = (config.task ?? '').trim();
  if (task !== '' && task !== callsign) return { title: task, ferret: callsign === '' ? null : callsign };
  const folder = config.cwd ? baseName(config.cwd) : '';
  if (folder !== '') return { title: folder, ferret: callsign === '' ? null : callsign };
  return { title: callsign || config.id, ferret: null };
};

// ─── paths ───────────────────────────────────────────────────────────────────────────────────────────────────────

export const daemonHomePath = (id: DaemonId): string => `/d/${encodeURIComponent(id)}`;
export const daemonSettingsPath = (id: DaemonId): string => `${daemonHomePath(id)}/settings`;
export const daemonAgendaPath = (id: DaemonId): string => `${daemonHomePath(id)}/agenda`;
export const daemonFerretPath = (id: DaemonId, ferret: string): string =>
  `${daemonHomePath(id)}/ferrets/${encodeURIComponent(ferret)}/chat`;

// ─── the daemon on screen and the paired daemons ──────────────────────────────────────────────────────────────────

/** The daemon the screen or settings tab is on. */
export const useCurrentDaemon: () => DaemonConnection = missing('useCurrentDaemon') as () => DaemonConnection;
/** Every paired daemon, in the order and under the names the ferrets bar shows them (a twin is told apart). */
export const useWardenMachines: () => readonly { readonly connection: DaemonConnection; readonly name: string }[] =
  missing('useWardenMachines') as () => readonly { readonly connection: DaemonConnection; readonly name: string }[];
/** The ferrets of one paired daemon, or `null` while they are not read. */
export const useFerretsOf: (daemonId: DaemonId) => readonly FerretView[] | null = missing('useFerretsOf') as (
  daemonId: DaemonId,
) => readonly FerretView[] | null;
/** This device's remembered choices (the daemon the Warden page is narrowed to). */
export const useDeviceControls: () => DaemonControlsStore = missing('useDeviceControls') as () => DaemonControlsStore;

// ─── pure helpers, copied unchanged from the app shell so this half runs and tests on its own ─────────────────────

const SYSTEM_CALLSIGN_PATTERN = /^(warden|learning|pack)-([0-9a-f]{6})$/iu;

/** A callsign Ferretry gave a ferret it started itself (`warden-00002a`), shown as an identifier. */
const isSystemCallsign = (callsign: string): boolean => {
  const match = SYSTEM_CALLSIGN_PATTERN.exec(callsign.trim());
  return match?.[2] !== undefined && Number.parseInt(match[2], 16) !== 0;
};

/** Title-cases a callsign slug for display: `ms-98` becomes `Ms-98`; a system callsign shows its hex digits uppercase. */
export const displayCallsign = (raw: string | null | undefined): string => {
  const slug = (raw ?? '').trim();
  if (slug === '') return '';
  if (isSystemCallsign(slug)) {
    const match = SYSTEM_CALLSIGN_PATTERN.exec(slug);
    return `${(match?.[1] ?? '').toLowerCase()}-${(match?.[2] ?? '').toUpperCase()}`;
  }
  return slug
    .split('-')
    .map(segment => (segment === '' ? segment : `${segment[0]?.toUpperCase() ?? ''}${segment.slice(1)}`))
    .join('-');
};

/** A ferret id cut to eight characters for a label. */
export const shortFerretId = (id: string): string => (id.length > 8 ? `${id.slice(0, 8)}…` : id);

/** `now`, `5m ago`, `3h ago`, `2d ago`; an unreadable instant is a dash. `now` is the caller's clock. */
export const relativeTime = (at: number | string | undefined, now: number = shellClock.nowMs()): string => {
  if (!at) return '—';
  const timestamp = typeof at === 'number' ? at : Date.parse(at);
  if (!Number.isFinite(timestamp)) return '—';
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 60) return 'now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};
