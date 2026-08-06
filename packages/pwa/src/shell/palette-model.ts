/**
 * Everything the command palette decides, worked out without a DOM. Ported from
 * the projections kteam computed inline in `ui/src/components/CommandPalette.tsx`.
 *
 * The palette's hard parts are all arithmetic: which groups appear, where each
 * group starts in one flat option list, which option `aria-activedescendant`
 * points at after an arrow key, and what the live region announces. Every one of
 * those is a correctness bug when it drifts — an offset that is one out points a
 * screen reader at the wrong row — so they live here as pure functions rather
 * than as expressions inside JSX.
 *
 * ONE DAEMON PER PALETTE. Sessions arrive as that daemon's views and settings
 * anchors are built from that daemon's settings path, so a palette opened on one
 * daemon can neither list nor navigate to another's. There is no module-level
 * cache in here at all: the results are derived on every render from the props,
 * which is the only shape that cannot serve a stale daemon's fleet.
 */

import type { SessionView } from '@ferretry/protocol';
import { displayCallsign, shortSessionId } from '../lib/callsign.ts';
import type { DaemonId } from '../lib/daemon-connection.ts';
// The palette names a folder exactly as the sidebar and dashboard do. Sharing
// `fleet-grouping`'s `baseName` is what keeps a session searchable under the
// same folder name the group header shows it under.
import { baseName } from '../lib/fleet-grouping.ts';
import { daemonSettingsPath } from '../lib/pages/routes.ts';
import {
  type AppBarDestinationLike,
  type DestinationPaletteEntry,
  destinationPaletteEntries,
} from './palette-destinations.ts';
import { MAX_SESSION_RESULTS, rankSessions, recentSessions, type SessionEntry } from './palette-ranking.ts';
import { statusMark, TERMINAL_STATUSES } from './status-mark.tsx';
import { parseTaskName } from './task-name.ts';

/** A ranked session plus the two rendered facts the ranker does not own. */
export interface PaletteSession extends SessionEntry {
  readonly view: SessionView;
  /** The project group's display name, without the cwd the matcher also sees. */
  readonly folderName: string;
  /** The rendered headline: the callsign, else the name, else a short id. */
  readonly headline: string;
  /** The short id rendered on the right of the row. */
  readonly shortId: string;
}

/**
 * A one-off action rather than a place. The palette carries whichever ones its
 * host hands it: nothing about opening a browser-login window or restarting a
 * daemon belongs to the shell's chrome, and a command list baked in here would
 * be a second source of truth for what the app can do.
 */
export interface PaletteCommand {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /**
   * The words a reader might type that appear in neither the label nor the
   * description. An empty query matches every command.
   */
  readonly searchTerms: string;
  readonly run: () => void;
}

/**
 * One searchable control from the settings catalog. The catalog itself belongs
 * to the settings surface — the palette takes what that surface publishes rather
 * than keeping a copy, so a searchable control cannot drift from the page that
 * owns it.
 */
export interface PaletteSettingsEntry {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /**
   * The anchor within this daemon's settings page. Null for a row that has no
   * one control to anchor to — "Open settings" itself, or a link row — which
   * lands on the unanchored Settings page instead.
   */
  readonly settingId: string | null;
  /**
   * Set only for a row that lives on a different page entirely (Warden's
   * failover configuration, say). Such a row navigates on every layout, because
   * there is no settings section to open for it.
   */
  readonly href?: string;
}

export type PaletteResult =
  | { readonly kind: 'destination'; readonly entry: DestinationPaletteEntry }
  | { readonly kind: 'command'; readonly entry: PaletteCommand }
  | { readonly kind: 'settings'; readonly entry: PaletteSettingsEntry }
  | { readonly kind: 'session'; readonly entry: PaletteSession };

/**
 * Stable element ids. The palette is a SINGLETON — its host mounts exactly one —
 * so these are constants rather than `useId()` values: an option id that changed
 * identity between renders would break `aria-activedescendant` for exactly the
 * readers who depend on it.
 */
export const PALETTE_IDS = {
  panel: 'fy-palette',
  input: 'fy-palette-input',
  listbox: 'fy-palette-listbox',
  commandsHeading: 'fy-palette-group-commands',
  destinationsHeading: 'fy-palette-group-destinations',
  settingsHeading: 'fy-palette-group-settings',
  sessionsHeading: 'fy-palette-group-sessions',
} as const;

/** The option id for one result, by kind. */
export const paletteResultId = (result: PaletteResult): string => {
  switch (result.kind) {
    case 'command':
      return `fy-palette-option-command-${result.entry.id}`;
    case 'destination':
      return `fy-palette-option-${result.entry.id}`;
    case 'settings':
      return `fy-palette-option-${result.entry.id}`;
    default:
      return `fy-palette-option-session-${result.entry.id}`;
  }
};

export type PaletteGroup = 'destinations' | 'commands' | 'settings' | 'sessions';

/**
 * What each group is called. A resting palette is answering "where can I go and
 * what can I do", so its headings name capabilities; once the reader types, the
 * palette is answering "what matched", so the headings name what the rows ARE.
 *
 * One deliberate departure from kteam: its resting commands heading read
 * "Browser", because the single command it carried opened a browser-login
 * window. Commands are injected here, so a heading naming one of them would be
 * wrong for every other one; "Actions" is the resting form. Every other string
 * is kteam's, verbatim.
 */
const GROUP_HEADINGS: Readonly<Record<PaletteGroup, { readonly resting: string; readonly searching: string }>> = {
  destinations: { resting: 'Go to', searching: 'Go to' },
  commands: { resting: 'Actions', searching: 'Commands' },
  settings: { resting: 'Commands', searching: 'Settings' },
  sessions: { resting: 'Recent sessions', searching: 'Sessions' },
};

/** The heading one group shows, given whether the reader has typed anything. */
export const paletteGroupHeading = (group: PaletteGroup, searching: boolean): string =>
  searching ? GROUP_HEADINGS[group].searching : GROUP_HEADINGS[group].resting;

/**
 * Flattens one daemon's session views into rankable entries.
 *
 * The searchable fields are RAW — `config.teammate` as stored, never the display
 * casing — while `headline` is the rendered form. Keeping both on the same
 * object is what stops a later edit from accidentally ranking over the rendered
 * string.
 */
export const paletteSessionEntries = (views: readonly SessionView[]): PaletteSession[] =>
  views.map(view => {
    const { config, state } = view;
    const folderName = config.cwd ? baseName(config.cwd) : '';
    const teammate = (config.teammate ?? '').trim();
    return {
      id: config.id,
      teammate,
      task: parseTaskName(config.name).task,
      label: (config.label ?? '').trim(),
      // The group name AND the path: readers hunt by either, and the ranker
      // finds the tightest window inside whichever one hit.
      folder: [folderName, config.cwd].filter(Boolean).join(' '),
      activityAt: Date.parse(state.lastActivityAt ?? config.updatedAt ?? '') || 0,
      active: statusMark(view).klass === 'active',
      finished: TERMINAL_STATUSES.has(state.status),
      view,
      folderName,
      headline: displayCallsign(teammate) || config.name || shortSessionId(config.id),
      shortId: shortSessionId(config.id),
    };
  });

/** Does this command answer the query? An empty query offers all of them. */
export const matchesPaletteCommand = (command: PaletteCommand, query: string): boolean => {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [command.label, command.description, command.searchTerms].join(' ').toLowerCase().includes(needle);
};

/** The anchor one settings control lives at, within its own daemon's page. */
export const paletteSettingHref = (daemon: DaemonId, settingId: string | null): string =>
  settingId === null ? daemonSettingsPath(daemon) : `${daemonSettingsPath(daemon)}#${settingId}`;

/**
 * Where the Settings group is already sending people. A section row lands on its
 * own anchor, which is a different destination from the settings page itself and
 * does not suppress it.
 */
export const settingsDestinationHrefs = (daemon: DaemonId, entries: readonly PaletteSettingsEntry[]): string[] =>
  entries.map(entry => entry.href ?? paletteSettingHref(daemon, entry.settingId));

export interface PaletteInput {
  readonly query: string;
  readonly daemon: DaemonId;
  readonly sessions: readonly PaletteSession[];
  readonly destinations: readonly AppBarDestinationLike[];
  readonly commands: readonly PaletteCommand[];
  /** Already matched by the Settings catalog, which owns labels, descriptions,
   *  anchors, and search terms as one decision. */
  readonly settings: readonly PaletteSettingsEntry[];
  /** Injected so ranking is deterministic under test. */
  readonly now?: number;
}

export interface PaletteResults {
  readonly destinations: readonly DestinationPaletteEntry[];
  readonly commands: readonly PaletteCommand[];
  readonly settings: readonly PaletteSettingsEntry[];
  readonly sessions: readonly PaletteSession[];
  /** Every group flattened, in rendered order. */
  readonly results: readonly PaletteResult[];
  /**
   * The index each group's first row occupies in `results`. One arithmetic
   * source for the rendered rows: a group appearing or vanishing cannot leave
   * `aria-activedescendant` pointing at the wrong row.
   */
  readonly offsets: Readonly<Record<PaletteGroup, number>>;
}

/**
 * The whole result list for one keystroke.
 *
 * Destinations lead. On a phone the palette IS the navigation surface — the bar
 * has one icon-sized opener and no room for tabs — so opening it cold must
 * answer "where can I go" before it answers anything else.
 */
export const paletteResults = (input: PaletteInput): PaletteResults => {
  // Taken as given: the Settings catalog already decided which of its controls
  // this query names, and re-filtering here would answer that twice.
  const settings = input.settings;
  const destinations = destinationPaletteEntries(input.query, input.destinations, input.daemon, {
    taken: settingsDestinationHrefs(input.daemon, settings),
  });
  const commands = input.commands.filter(command => matchesPaletteCommand(command, input.query));
  const sessions = input.query.trim()
    ? rankSessions(input.sessions, input.query, {
        limit: MAX_SESSION_RESULTS,
        ...(input.now === undefined ? {} : { now: input.now }),
      })
    : recentSessions(input.sessions);

  const results: PaletteResult[] = [
    ...destinations.map(entry => ({ kind: 'destination' as const, entry })),
    ...commands.map(entry => ({ kind: 'command' as const, entry })),
    ...settings.map(entry => ({ kind: 'settings' as const, entry })),
    ...sessions.map(entry => ({ kind: 'session' as const, entry })),
  ];

  const commandsOffset = destinations.length;
  const settingsOffset = commandsOffset + commands.length;
  const sessionsOffset = settingsOffset + settings.length;

  return {
    destinations,
    commands,
    settings,
    sessions,
    results,
    offsets: { destinations: 0, commands: commandsOffset, settings: settingsOffset, sessions: sessionsOffset },
  };
};

/**
 * The active row, DERIVED and clamped rather than corrected in an effect: a
 * streaming fleet can shrink the result list between renders, and an effect
 * would commit one frame pointing `aria-activedescendant` at an option that no
 * longer exists. `-1` means there is nothing to point at.
 */
export const clampActiveIndex = (active: number, count: number): number =>
  count === 0 ? -1 : Math.min(Math.max(active, 0), count - 1);

/**
 * Where an arrow, Home or End key moves the active row. Wrapping is deliberate:
 * a palette whose list is shorter than the reader expected should return to the
 * top rather than stop dead at the bottom.
 *
 * `null` means the key is not one this list answers to and the event must be
 * left alone — the browser still owns Home and End inside the text box when
 * there is nothing to move through.
 */
export const nextActiveIndex = (active: number, count: number, key: string): number | null => {
  if (count === 0) return null;
  const from = Math.min(Math.max(active, 0), count - 1);
  switch (key) {
    case 'ArrowDown':
      return (from + 1) % count;
    case 'ArrowUp':
      return (from - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
};

/**
 * What the live region says. Deliberately debounced by the caller: a fast typist
 * should hear one settled count, not a stream of intermediate ones.
 */
export const paletteCountLabel = (count: number): string =>
  count === 0 ? 'No results' : `${count} result${count === 1 ? '' : 's'}`;

/**
 * Where focus goes when the palette opens.
 *
 * A touch-affected reader gets the dialog container focused and NOT the text
 * box: autofocusing an input on a phone summons the on-screen keyboard over the
 * results the reader opened the palette to read. A keyboard reader gets the box,
 * because typing is why they pressed the shortcut.
 */
export const paletteFocusPolicy = (
  touchAffected: boolean,
): { readonly dialogAutoFocus: boolean; readonly inputAutoFocus: boolean } => ({
  dialogAutoFocus: touchAffected,
  inputAutoFocus: !touchAffected,
});
