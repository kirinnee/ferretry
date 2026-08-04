/**
 * THE UNIFIED SIDE-PANE TAB MODEL — the single source of truth for tab identity
 * and per-(daemon, session) tab state. Ported from kteam
 * `ui/src/lib/side-pane-tab-model.ts`; the design record is
 * `DESIGN-side-pane-tabs.md`.
 *
 * Three halves, one file:
 *
 *   REGISTRY   which SINGLETON tabs exist at all. The built-in surfaces are
 *              declared here; later modules (browser HUD, files bar, skills
 *              groups) call `registerSidePaneTab` from their own module scope
 *              and appear in the strip without touching this file. The registry
 *              is versioned and subscribable, so late registration re-renders
 *              any live strip.
 *   INSTANCES  IDE-style per-instance tabs: ONE TAB PER OPEN FILE, ONE PER
 *              BROWSER PAGE, ONE PER TERMINAL. An instance tab's id carries its
 *              identity (`file:<path>`, `browser:<pageId>`, `terminal:<id>`);
 *              opening the same file twice focuses the existing tab instead of
 *              duplicating it, and closing an instance disposes only that
 *              instance — closing the last one leaves no phantom singleton.
 *   STATE      which tabs are OPEN in a strip and which one is ACTIVE. Module
 *              state, not React state: retained session panes are created and
 *              destroyed by the app-level LRU, and an evicted-then-revisited
 *              session must come back to the tabs it had.
 *
 * Every session starts with the human's chosen default strip: tasks, skills,
 * tree (lineage), mcp and cost (analytics) — all singletons, all utility tabs.
 * Files, browser pages and terminals join the strip as INSTANCE tabs when
 * something opens them.
 *
 * THREE DELIBERATE DEPARTURES FROM THE ORIGINAL:
 *
 *   1. State is keyed by `(daemonId, sessionId)`, never by session id alone
 *      (`docs/migration/surveys/pwa-shape.md` item 52). Two daemons routinely
 *      hand out the same session id, and a strip that survived a daemon switch
 *      would show one daemon's open files under another's session.
 *   2. `SidePaneTabsState.browser`, the wave-1 singleton browser payload, is
 *      gone along with `setSidePaneBrowserDestination`. It existed purely as a
 *      back-compat seam for historical snapshot readers; Ferretry starts empty
 *      and has none. Live pages carry their own destination.
 *   3. PINS AND ATTENTION ARE NOT TABS. `DESIGN-side-pane-tabs.md` lists both
 *      among the wave-1 utility singletons; handover row #35 overrules it —
 *      "Pins and Attention do not belong in this bento/side-pane model". They
 *      have their own homes: #63 puts pins in a top link strip, #17 gives
 *      Attention a focused action modal. Neither id is registered here, and
 *      `openSidePaneTab` refuses an unregistered id rather than parking a tab
 *      that resolves to nothing.
 */

import type { ReactNode } from 'react';
import type { DaemonSessionScope } from '../lib/daemon-scope.ts';
import { daemonSessionKey } from '../lib/daemon-scope.ts';

/** Built-in tabs use the historical surface literals as their ids; instance
 *  tabs carry their instance in the id (`file:<path>`, …). */
export type SidePaneTabId = string;

export type SidePaneTabPresentation = 'pane' | 'sheet';

/**
 * The destination model now has ONE home: `features/browser/in-app-browser-model.ts`,
 * which is where the surface that opens it lives. This module used to carry a
 * second copy because that surface was unported; re-exporting keeps the tab
 * model's public surface unchanged while removing the chance of the two
 * definitions drifting apart.
 */
import type { BrowserDestination } from '../features/browser/in-app-browser-model.ts';

export type { BrowserDestination, BrowserScope } from '../features/browser/in-app-browser-model.ts';

// ---- instance identity -------------------------------------------------------

/** The three per-instance tab kinds. Utility tabs stay singletons. */
export type SidePaneInstanceKind = 'file' | 'browser' | 'terminal';

/** A code-reference line range riding with a file instance tab. */
export interface SidePaneFileSelection {
  readonly line: number;
  readonly endLine?: number;
  readonly column?: number;
}

/** One open instance: a file, a browser page, or a terminal. */
export interface SidePaneTabInstance {
  readonly id: SidePaneTabId;
  readonly kind: SidePaneInstanceKind;
  /** Kind-scoped identity: the file path, the page id, the terminal id. */
  readonly key: string;
  /** Short strip label: basename for files, page title or host for browser. */
  readonly label: string;
  /** Full path/URL — the hover title and the accessible name. */
  readonly title: string;
  /** Insertion counter; instances render after utility tabs, grouped by kind
   *  (files, then browser pages, then terminals), in opening order. */
  readonly order: number;
  /** Browser instances: this page's destination (null = the "Where to?" home). */
  readonly destination?: BrowserDestination | null;
  /** File instances: the delivered line range, cleared on plain re-open. */
  readonly selection?: SidePaneFileSelection;
  /** Monotonic per-instance write counter, so a repeated delivery to an
   *  already-open tab (same file, new line range) is observable. */
  readonly revision: number;
}

export function sidePaneInstanceTabId(kind: SidePaneInstanceKind, key: string): SidePaneTabId {
  return `${kind}:${key}`;
}

const INSTANCE_ID_PATTERN = /^(file|browser|terminal):(.+)$/u;

/** Parse an instance id. Singleton ids (no recognised kind prefix) parse to
 *  null — a registered id that merely contains a colon is not ours. */
export function parseSidePaneInstanceTabId(id: SidePaneTabId): { kind: SidePaneInstanceKind; key: string } | null {
  const match = INSTANCE_ID_PATTERN.exec(id);
  if (!match) return null;
  return { kind: match[1] as SidePaneInstanceKind, key: match[2] ?? '' };
}

/** Strip block for each kind: instances render after every utility tab
 *  (utility orders are two-digit), files before pages before terminals. */
const INSTANCE_KIND_ORDER: Record<SidePaneInstanceKind, number> = { file: 1000, browser: 2000, terminal: 3000 };

/**
 * The icon each instance kind wears in the strip. Icons are named, not imported
 * component references: the model stays a plain data module and the components
 * layer owns the one map from name to glyph.
 */
const INSTANCE_KIND_ICON: Record<SidePaneInstanceKind, SidePaneTabIconName> = {
  file: 'file',
  browser: 'browser',
  terminal: 'terminal',
};

/** Browser pages and terminals hold live state (a logged-in page, a socket, a
 *  scrollback); a file body is a cheap re-fetch. */
const INSTANCE_KIND_RETAIN: Record<SidePaneInstanceKind, boolean> = { file: false, browser: true, terminal: true };

// ---- tab definitions ---------------------------------------------------------

/** Every glyph the strip can show. `side-pane-tab-icons.tsx` resolves these. */
export type SidePaneTabIconName =
  | 'tasks'
  | 'skills'
  | 'lineage'
  | 'mcp'
  | 'analytics'
  | 'browser'
  | 'files'
  | 'terminal'
  | 'file';

/** The contract a registered (non-built-in) tab body renders against. Kept
 *  deliberately small: built-in surfaces need bespoke delivery props (task,
 *  code-reference, attention and pin requests) that this generic surface must
 *  not grow, so they render through the side pane's own switch instead. */
export interface SidePaneTabRenderProps {
  readonly scope: DaemonSessionScope;
  readonly presentation: SidePaneTabPresentation;
  readonly titleId: string;
  readonly onClose: () => void;
  readonly cwd?: string;
  readonly isActive: boolean;
  /** Present when this body renders an instance tab. */
  readonly instance?: SidePaneTabInstance;
}

export interface SidePaneTabDefinition {
  readonly id: SidePaneTabId;
  /** Full accessible name ("Lineage"; a file's full path). */
  readonly label: string;
  /** Compact strip name ("Tree"; a file's basename); the full label stays the
   *  accessible name. */
  readonly shortLabel: string;
  /** Sheet dismiss label. */
  readonly closeLabel: string;
  readonly icon: SidePaneTabIconName;
  /** Strip position; open tabs render sorted by this, then by label. */
  readonly order: number;
  /** Member of the default strip every fresh session starts with. */
  readonly defaultOpen?: boolean;
  /** Honest capability gate. The tab still exists and is still selectable —
   *  its body renders an explicit placeholder, never a pretend data source. */
  readonly unavailableReason?: string;
  /** Once opened, the surface stays mounted (hidden) on desktop: it owns
   *  something expensive or live (a socket, a scrollback, a logged-in page). */
  readonly retain?: boolean;
  /** Body for tabs registered outside the side pane. Built-ins omit it. */
  readonly render?: (props: SidePaneTabRenderProps) => ReactNode;
  /** This catalogue entry opens PER-INSTANCE tabs instead of toggling a
   *  singleton: the + picker creates a NEW instance of this kind, and the
   *  entry's own id never sits in the strip. */
  readonly instanceKind?: SidePaneInstanceKind;
  /** Present on the synthesized definition of an open instance tab. */
  readonly instance?: SidePaneTabInstance;
}

// ---- built-in tabs ---------------------------------------------------------
//
// Array order is the HISTORICAL surface key order (the bento launcher preserves
// it); `order` is the STRIP order, which follows the human's default-tab
// listing MINUS pins and needs: tasks, skills, tree, mcp, cost — then the
// on-demand catalogue entries web, files, terminals. The two `order` values the
// removed tabs held (10 and 60) are deliberately left as gaps rather than
// renumbered, so a strip persisted by an earlier build sorts unchanged.
//
// `browser` is a CATALOGUE entry, not a strip tab: every open of it becomes a
// per-page instance tab (`instanceKind`). `files` is the file PICKER — the
// directory tree surface; the files it opens become per-file instance tabs.
// `terminals` still hosts the multi-terminal deck as a singleton; the model
// already speaks `terminal:<id>` so the deck can hand each terminal its own tab
// without another model change.

export const SIDE_PANE_BUILT_IN_TABS: readonly SidePaneTabDefinition[] = [
  {
    id: 'browser',
    label: 'Browser',
    shortLabel: 'Web',
    closeLabel: 'Close browser',
    icon: 'browser',
    order: 80,
    retain: true,
    instanceKind: 'browser',
  },
  { id: 'files', label: 'Files', shortLabel: 'Files', closeLabel: 'Close files', icon: 'files', order: 90 },
  {
    id: 'tasks',
    label: 'Tasks',
    shortLabel: 'Tasks',
    closeLabel: 'Close tasks',
    icon: 'tasks',
    order: 20,
    defaultOpen: true,
  },
  {
    id: 'terminals',
    label: 'Terminals',
    shortLabel: 'Term',
    closeLabel: 'Close terminals',
    icon: 'terminal',
    order: 100,
    retain: true,
  },
  {
    id: 'skills',
    label: 'Skills',
    shortLabel: 'Skill',
    closeLabel: 'Close skills',
    icon: 'skills',
    order: 30,
    defaultOpen: true,
  },
  {
    id: 'lineage',
    label: 'Lineage',
    shortLabel: 'Tree',
    closeLabel: 'Close lineage',
    icon: 'lineage',
    order: 40,
    defaultOpen: true,
  },
  {
    id: 'analytics',
    label: 'Analytics',
    shortLabel: 'Cost',
    closeLabel: 'Close analytics',
    icon: 'analytics',
    order: 70,
    defaultOpen: true,
  },
  {
    id: 'mcp',
    label: 'MCP',
    shortLabel: 'MCP',
    closeLabel: 'Close MCP',
    icon: 'mcp',
    order: 50,
    defaultOpen: true,
    unavailableReason: 'No MCP data source is connected yet.',
  },
];

// ---- registry --------------------------------------------------------------

const registry = new Map<SidePaneTabId, SidePaneTabDefinition>(SIDE_PANE_BUILT_IN_TABS.map(def => [def.id, def]));
let registryVersion = 0;
const registryListeners = new Set<() => void>();

let definitionsCache: readonly SidePaneTabDefinition[] | null = null;
let defaultOpenCache: SidePaneTabsState | null = null;

function bumpRegistry(): void {
  registryVersion += 1;
  definitionsCache = null;
  defaultOpenCache = null;
  for (const listener of registryListeners) listener();
}

/** Monotonic registry write counter — a cheap `useSyncExternalStore` key. */
export function getSidePaneTabRegistryVersion(): number {
  return registryVersion;
}

/** Register (or replace — last registration wins, so hot reload cannot dupe)
 *  one tab definition. Returns the unregister function. Registering a tab with
 *  `defaultOpen` affects strips that have not been touched yet; strips with
 *  existing state keep the tabs they had. */
export function registerSidePaneTab(definition: SidePaneTabDefinition): () => void {
  registry.set(definition.id, definition);
  bumpRegistry();
  return () => {
    if (registry.get(definition.id) !== definition) return;
    registry.delete(definition.id);
    bumpRegistry();
  };
}

export function getSidePaneTabDefinition(id: SidePaneTabId): SidePaneTabDefinition | undefined {
  return registry.get(id);
}

/** Every registered tab, in strip order. Snapshot identity is stable between
 *  registry versions, so this is safe as a `useSyncExternalStore` snapshot. */
export function getSidePaneTabDefinitions(): readonly SidePaneTabDefinition[] {
  definitionsCache ??= [...registry.values()].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
  return definitionsCache;
}

export function subscribeSidePaneTabRegistry(listener: () => void): () => void {
  registryListeners.add(listener);
  return () => {
    registryListeners.delete(listener);
  };
}

/** Test seam: drop every non-built-in registration. */
export function resetSidePaneTabRegistry(): void {
  registry.clear();
  for (const definition of SIDE_PANE_BUILT_IN_TABS) registry.set(definition.id, definition);
  instanceBodies.clear();
  bumpRegistry();
}

// ---- instance bodies -------------------------------------------------------
//
// `registerSidePaneTab` covers singleton tabs; an instance KIND registers one
// body for every tab of that kind. The side pane renders file and browser
// instances through its own switch (they need the files tree and browser
// surface plumbing); the terminals deck claims its kind from its own module
// scope, exactly like `registerSidePaneTab`.

export type SidePaneInstanceBody = (props: SidePaneTabRenderProps) => ReactNode;

const instanceBodies = new Map<SidePaneInstanceKind, SidePaneInstanceBody>();

/** Register (or replace) the body for one instance kind. Returns the unregister
 *  function; a stale unregister cannot tear down a replacement. */
export function registerSidePaneInstanceBody(kind: SidePaneInstanceKind, render: SidePaneInstanceBody): () => void {
  instanceBodies.set(kind, render);
  bumpRegistry();
  return () => {
    if (instanceBodies.get(kind) !== render) return;
    instanceBodies.delete(kind);
    bumpRegistry();
  };
}

export function getSidePaneInstanceBody(kind: SidePaneInstanceKind): SidePaneInstanceBody | undefined {
  return instanceBodies.get(kind);
}

// ---- per-(daemon, session) state -------------------------------------------

export interface SidePaneTabsState {
  /** The strip. Kept in strip order at every write. */
  readonly open: readonly SidePaneTabId[];
  /** The showing tab; null means the pane is closed (the strip survives). */
  readonly active: SidePaneTabId | null;
  /** Open instance tabs by id. Everything in here is also in `open`. */
  readonly instances: Readonly<Record<SidePaneTabId, SidePaneTabInstance>>;
}

const NO_INSTANCES: Readonly<Record<SidePaneTabId, SidePaneTabInstance>> = Object.freeze({});

/** Keyed by `daemonSessionKey`: a matching session id from a different daemon
 *  is a different strip, always. */
const tabStates = new Map<string, SidePaneTabsState>();
let stateVersion = 0;
const stateListeners = new Set<() => void>();
/** Monotonic insertion counter for instance ordering and page ids. */
let instanceSequence = 0;

function defaultState(): SidePaneTabsState {
  defaultOpenCache ??= {
    open: getSidePaneTabDefinitions()
      .filter(def => def.defaultOpen)
      .map(def => def.id),
    active: null,
    instances: NO_INSTANCES,
  };
  return defaultOpenCache;
}

function notifyState(): void {
  stateVersion += 1;
  for (const listener of stateListeners) listener();
}

export function subscribeSidePaneTabsState(listener: () => void): () => void {
  stateListeners.add(listener);
  return () => {
    stateListeners.delete(listener);
  };
}

/** Monotonic write counter — a cheap `useSyncExternalStore` snapshot key. */
export function getSidePaneTabsVersion(): number {
  return stateVersion;
}

/** Stable-identity read: the same object comes back until the next write to
 *  this daemon/session pair (or, for untouched pairs, the next registry
 *  change). */
export function readSidePaneTabsState(scope: DaemonSessionScope): SidePaneTabsState {
  return tabStates.get(daemonSessionKey(scope)) ?? defaultState();
}

export function readSidePaneTabInstance(scope: DaemonSessionScope, id: SidePaneTabId): SidePaneTabInstance | undefined {
  return readSidePaneTabsState(scope).instances[id];
}

/** Resolve any open tab id to a renderable definition: registry entries come
 *  back as registered; an instance id synthesizes its definition from the
 *  instance (label = full path/URL, shortLabel = basename/host). An unknown id
 *  resolves to nothing — absence must not invent a tab. */
export function resolveSidePaneTab(scope: DaemonSessionScope, id: SidePaneTabId): SidePaneTabDefinition | undefined {
  const registered = registry.get(id);
  if (registered) return registered;
  const instance = readSidePaneTabsState(scope).instances[id];
  if (!instance) return undefined;
  return {
    id,
    label: instance.title,
    shortLabel: instance.label,
    closeLabel: `Close ${instance.label}`,
    icon: INSTANCE_KIND_ICON[instance.kind],
    order: INSTANCE_KIND_ORDER[instance.kind] + instance.order,
    retain: INSTANCE_KIND_RETAIN[instance.kind],
    instance,
  };
}

type StripSortKey = readonly [number, number, string];

function stripSortKey(
  id: SidePaneTabId,
  instances: Readonly<Record<SidePaneTabId, SidePaneTabInstance>>,
): StripSortKey {
  const def = registry.get(id);
  if (def) return [def.order, 0, def.label];
  const instance = instances[id];
  if (instance) return [INSTANCE_KIND_ORDER[instance.kind], instance.order, instance.label];
  // Unknown tabs sort last and render nowhere — an unknown tab must not invent
  // a position.
  return [Number.MAX_SAFE_INTEGER, 0, id];
}

/** Sort open-tab ids into strip order: utility tabs by registry order, then
 *  instance tabs grouped files → pages → terminals in opening order. */
export function sortSidePaneTabs(
  ids: readonly SidePaneTabId[],
  instances: Readonly<Record<SidePaneTabId, SidePaneTabInstance>> = NO_INSTANCES,
): readonly SidePaneTabId[] {
  return [...ids].sort((a, b) => {
    const ka = stripSortKey(a, instances);
    const kb = stripSortKey(b, instances);
    return ka[0] - kb[0] || ka[1] - kb[1] || ka[2].localeCompare(kb[2]) || a.localeCompare(b);
  });
}

function write(scope: DaemonSessionScope, next: SidePaneTabsState): void {
  tabStates.set(daemonSessionKey(scope), next);
  notifyState();
}

/** Low-level whole-state write — the test seam and the restore path. */
export function writeSidePaneTabsState(scope: DaemonSessionScope, next: SidePaneTabsState): void {
  const instances = next.instances ?? NO_INSTANCES;
  write(scope, { ...next, instances, open: sortSidePaneTabs(next.open, instances) });
}

/** Add a tab to the strip if absent and make it active. The single open path:
 *  the + picker, header toggles, transcript links and reference deliveries all
 *  land here, so opening a non-default surface always materialises its tab. A
 *  catalogue entry that spawns instances (`instanceKind`) redirects: it focuses
 *  the most recent instance of that kind, or creates a fresh one, so its
 *  singleton id never enters the strip.
 *
 *  An id that is neither registered nor an already-open instance is REFUSED.
 *  Pins and Attention left this model (handover #35) and their old callers are
 *  exactly the shape this guards: parking an id that `resolveSidePaneTab`
 *  cannot resolve produced a strip entry rendering nowhere and a pane the host
 *  had to deactivate on the next effect. Absence must refuse, not invent. */
export function openSidePaneTab(scope: DaemonSessionScope, id: SidePaneTabId): void {
  const definition = registry.get(id);
  if (definition?.instanceKind === 'browser') {
    openSidePaneBrowserTab(scope, null);
    return;
  }
  if (definition === undefined && readSidePaneTabsState(scope).instances[id] === undefined) return;
  const current = readSidePaneTabsState(scope);
  const open = current.open.includes(id) ? current.open : sortSidePaneTabs([...current.open, id], current.instances);
  if (open === current.open && current.active === id) return;
  write(scope, { ...current, open, active: id });
}

function openInstance(scope: DaemonSessionScope, instance: SidePaneTabInstance): void {
  const current = readSidePaneTabsState(scope);
  const instances = { ...current.instances, [instance.id]: instance };
  const open = current.open.includes(instance.id)
    ? current.open
    : sortSidePaneTabs([...current.open, instance.id], instances);
  write(scope, { ...current, open, instances, active: instance.id });
}

/** ONE TAB PER FILE. Opening a path already in the strip focuses its existing
 *  tab (updating the delivered line selection) instead of duplicating it. */
export function openSidePaneFileTab(
  scope: DaemonSessionScope,
  path: string,
  selection?: SidePaneFileSelection,
): SidePaneTabId {
  const id = sidePaneInstanceTabId('file', path);
  const existing = readSidePaneTabsState(scope).instances[id];
  const basename = path.split('/').filter(Boolean).pop() ?? path;
  openInstance(scope, {
    id,
    kind: 'file',
    key: path,
    label: basename,
    title: path,
    order: existing?.order ?? ++instanceSequence,
    ...(selection ? { selection } : {}),
    revision: (existing?.revision ?? 0) + 1,
  });
  return id;
}

function browserTabLabel(destination: BrowserDestination | null): { label: string; title: string } {
  if (!destination) return { label: 'New page', title: 'New browser page' };
  try {
    return { label: new URL(destination.href).host || destination.href, title: destination.href };
  } catch {
    return { label: destination.href, title: destination.href };
  }
}

/** ONE TAB PER BROWSER PAGE. A destination that is already open in some page
 *  focuses that page; otherwise a new page tab is created. `forceNew` (the +
 *  picker) always creates a fresh page. With no destination, the most recent
 *  page is focused when one exists — the reader asked for "the browser", and a
 *  pile of blank pages is not what they meant. */
export function openSidePaneBrowserTab(
  scope: DaemonSessionScope,
  destination: BrowserDestination | null = null,
  options: { forceNew?: boolean } = {},
): SidePaneTabId {
  const current = readSidePaneTabsState(scope);
  const pages = Object.values(current.instances).filter(instance => instance.kind === 'browser');
  if (!options.forceNew) {
    const match = destination
      ? pages.find(page => page.destination?.href === destination.href)
      : pages.sort((a, b) => b.order - a.order)[0];
    if (match) {
      openInstance(scope, destination ? { ...match, revision: match.revision + 1 } : match);
      return match.id;
    }
  }
  const key = `page-${++instanceSequence}`;
  const id = sidePaneInstanceTabId('browser', key);
  openInstance(scope, {
    id,
    kind: 'browser',
    key,
    ...browserTabLabel(destination),
    order: instanceSequence,
    destination,
    revision: 1,
  });
  return id;
}

/** ONE TAB PER TERMINAL. The terminals deck (or any launcher) hands each
 *  terminal its own tab; re-opening an id focuses the existing tab. */
export function openSidePaneTerminalTab(scope: DaemonSessionScope, terminalId: string, label?: string): SidePaneTabId {
  const id = sidePaneInstanceTabId('terminal', terminalId);
  const existing = readSidePaneTabsState(scope).instances[id];
  openInstance(scope, {
    id,
    kind: 'terminal',
    key: terminalId,
    label: label ?? existing?.label ?? terminalId,
    title: label ?? existing?.title ?? terminalId,
    order: existing?.order ?? ++instanceSequence,
    revision: (existing?.revision ?? 0) + 1,
  });
  return id;
}

/** Retitle a live instance tab (a browser page navigated, a terminal was
 *  renamed) without touching focus or strip membership. */
export function setSidePaneInstanceLabel(
  scope: DaemonSessionScope,
  id: SidePaneTabId,
  next: { label: string; title?: string; destination?: BrowserDestination | null },
): void {
  const current = readSidePaneTabsState(scope);
  const instance = current.instances[id];
  if (!instance) return;
  write(scope, {
    ...current,
    instances: {
      ...current.instances,
      [id]: {
        ...instance,
        label: next.label,
        title: next.title ?? instance.title,
        ...(next.destination !== undefined ? { destination: next.destination } : {}),
        revision: instance.revision + 1,
      },
    },
  });
}

/** Switch among already-open tabs; a tab outside the strip is a no-op (use
 *  `openSidePaneTab` to add). */
export function activateSidePaneTab(scope: DaemonSessionScope, id: SidePaneTabId): void {
  const current = readSidePaneTabsState(scope);
  if (!current.open.includes(id) || current.active === id) return;
  write(scope, { ...current, active: id });
}

/** Close the pane. The strip — which tabs the reader chose — survives. */
export function deactivateSidePane(scope: DaemonSessionScope): void {
  const current = readSidePaneTabsState(scope);
  if (current.active === null) return;
  write(scope, { ...current, active: null });
}

// Closing an instance tab DISPOSES that instance; whoever owns its live backing
// (the terminals deck killing a pty) subscribes here.
export type SidePaneInstanceCloseListener = (scope: DaemonSessionScope, instance: SidePaneTabInstance) => void;
const instanceCloseListeners = new Set<SidePaneInstanceCloseListener>();

export function subscribeSidePaneInstanceClose(listener: SidePaneInstanceCloseListener): () => void {
  instanceCloseListeners.add(listener);
  return () => {
    instanceCloseListeners.delete(listener);
  };
}

/** Take a tab out of the strip (picker toggle-off, or an instance tab's ✕).
 *  Removing the active tab activates its nearest strip neighbour — the
 *  following tab when one exists, else the preceding one — and removing the
 *  last tab closes the pane.
 *
 *  A SINGLETON removal never unmounts a retained surface: hiding the terminals
 *  deck must not drop scrollback, exactly as switching away does not. An
 *  INSTANCE removal is a real close — the instance is disposed, its close
 *  listeners run, and no phantom tab survives it. */
export function removeSidePaneTab(scope: DaemonSessionScope, id: SidePaneTabId): void {
  const current = readSidePaneTabsState(scope);
  const index = current.open.indexOf(id);
  if (index === -1) return;
  const open = current.open.filter(tab => tab !== id);
  const active = current.active === id ? (open[index] ?? open[index - 1] ?? null) : current.active;
  const closed = current.instances[id];
  let instances = current.instances;
  if (closed) {
    const next = { ...current.instances };
    delete next[id];
    instances = next;
  }
  write(scope, { ...current, open, active, instances });
  if (closed) for (const listener of instanceCloseListeners) listener(scope, closed);
}

/** Forget every strip belonging to one daemon — what an unpairing must do, and
 *  the reason state is keyed by daemon at all. */
export function forgetDaemonSidePaneTabs(daemonId: string): void {
  for (const key of [...tabStates.keys()]) {
    const [cachedDaemonId] = JSON.parse(key) as [string, string];
    if (cachedDaemonId === daemonId) tabStates.delete(key);
  }
  notifyState();
}

/** Test seam — the memory is module state, so tests must start from nothing. */
export function resetSidePaneTabsStates(): void {
  tabStates.clear();
  notifyState();
}
