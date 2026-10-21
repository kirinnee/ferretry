/**
 * AGENT-OPENED SURFACES, AS TABS: when a ferret opens a terminal or a browser page, the workspace gets a
 * tab for it without anyone clicking a `%terminal:` / `%browser:` reference.
 *
 * The daemon journals `surface.opened` when an agent opens one and `surface.asked` when it hands one to
 * the owner (`docs/agent-tools.md`); `useSurfaceDriving` folds both. This hook turns them into layout
 * changes, through the pure operations in `workspace-layout.ts`, and into the three things the owner
 * sees:
 *
 *   OPENED   the tab is added and NOTHING the owner is doing moves: the focused pane and the selected
 *            tab stay put, so typing in the composer is never interrupted. A subtle notice says what
 *            happened, with Show, and the tab wears a dot until it has been looked at.
 *   ASKED    the agent handed the surface over ("your turn here"): the tab is brought forward and
 *            focused, wears a YOUR TURN badge, and its marker says what to do. Once per ask.
 *   CLOSED   closing the tab closes the VIEW only. It stays closed — the layout remembers it was
 *            announced — and the ＋ menu offers it back for as long as the surface is alive.
 *
 * Everything the workspace did on an agent's behalf is remembered in the layout (`announced`), so it
 * survives a reload and is per session, and a poll and an event that carry the same fact do it once.
 */

import type { SurfaceAsked, SurfaceKind, SurfaceOpened } from '@ferretry/protocol';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DaemonSessionScope } from '../../lib/daemon-scope.ts';
import {
  activateWorkspaceTab,
  adoptAgentSurface,
  bringAskedSurfaceForward,
  focusedWorkspaceTab,
  hasAnnounced,
  markAnnounced,
  openWorkspaceTab,
  type WorkspaceLayout,
  type WorkspaceTab,
  type WorkspaceTabId,
  workspaceTab,
} from '../../lib/workspace-layout.ts';
import type { WorkspaceLayoutStore } from '../../lib/workspace-layout-store.ts';
import { sidePaneInstanceTabId } from '../../shell/side-pane-tab-model.ts';
import type { SurfaceTimer } from './use-surface-driving.ts';

/** How long the "Agent opened …" notice stands when nobody dismisses it. */
export const AGENT_SURFACE_NOTICE_MS = 8_000;

interface AgentSurfaceNotice {
  readonly tabId: WorkspaceTabId;
  readonly text: string;
}

interface AgentSurfaceAsk {
  readonly agent: string;
  readonly message?: string;
}

/** A surface the agent opened whose tab is not open: ＋ offers it back. */
interface ReopenableSurface {
  readonly tabId: WorkspaceTabId;
  readonly kind: SurfaceKind;
  readonly label: string;
}

/** What the strips, chips and markers need to say about agent-opened surfaces. */
export interface AgentSurfaceTabs {
  /** Tabs an agent added that the owner has not looked at yet. */
  readonly unseenTabIds: ReadonlySet<WorkspaceTabId>;
  /** Tabs the agent has handed to the owner and nobody has taken yet. */
  readonly askedTabIds: ReadonlySet<WorkspaceTabId>;
  readonly notice: AgentSurfaceNotice | null;
  readonly dismissNotice: () => void;
  /** Brings the noticed tab forward. */
  readonly showNotice: () => void;
  readonly askFor: (tabId: WorkspaceTabId) => AgentSurfaceAsk | null;
  readonly dismissAsk: (tabId: WorkspaceTabId) => void;
  readonly reopenable: readonly ReopenableSurface[];
  readonly reopen: (tabId: WorkspaceTabId) => void;
}

/** The host has no agent surfaces to report. */
export const NO_AGENT_SURFACE_TABS: AgentSurfaceTabs = Object.freeze({
  unseenTabIds: new Set<WorkspaceTabId>(),
  askedTabIds: new Set<WorkspaceTabId>(),
  notice: null,
  dismissNotice: () => undefined,
  showNotice: () => undefined,
  askFor: () => null,
  dismissAsk: () => undefined,
  reopenable: [],
  reopen: () => undefined,
});

interface SurfaceRecord {
  readonly surface: SurfaceKind;
  readonly id: string;
  readonly name?: string;
}

interface SurfaceTab {
  readonly tab: WorkspaceTab;
  /** The other ids the same surface may be open under. */
  readonly aliases: readonly WorkspaceTabId[];
}

/**
 * The tab a surface wears. A terminal's tab is keyed by its id (the deck finds the shell by id); a
 * browser page's by its name, else its id (the page strip matches `name ?? id`). The other spelling is
 * an alias, so a tab opened from a `%terminal:dev` / `%browser:id` reference is the same tab.
 */
export const surfaceTabFor = (record: SurfaceRecord): SurfaceTab => {
  const label = record.name ?? record.id;
  if (record.surface === 'terminal')
    return {
      tab: workspaceTab('terminal', record.id, { label, title: `Terminal ${label}` }),
      aliases: record.name === undefined ? [] : [sidePaneInstanceTabId('terminal', record.name)],
    };
  return {
    tab: workspaceTab('browser', label, { label, title: `Browser page ${label}` }),
    aliases: record.name === undefined ? [] : [sidePaneInstanceTabId('browser', record.id)],
  };
};

const openedKey = (record: SurfaceRecord): string => `open:${record.surface}:${record.id}`;
const askKey = (asked: SurfaceAsked): string => `ask:${asked.surface}:${asked.id}:${asked.at}`;
const askDoneKey = (asked: SurfaceAsked): string => `ask-done:${asked.surface}:${asked.id}:${asked.at}`;

const noticeText = (opened: SurfaceOpened): string => {
  const who = opened.agentName ?? 'The agent';
  return `${who} opened ${opened.surface} ${opened.name ?? opened.id}`;
};

const defaultTimer: SurfaceTimer = (callback, delayMs) => {
  const handle = setTimeout(callback, delayMs);
  return () => clearTimeout(handle);
};

export interface AgentSurfaceTabsInput {
  readonly store: WorkspaceLayoutStore;
  readonly scope: DaemonSessionScope;
  readonly layout: WorkspaceLayout;
  readonly opened: readonly SurfaceOpened[];
  readonly asked: readonly SurfaceAsked[];
  readonly timer?: SurfaceTimer;
  readonly noticeMs?: number;
}

const hasTab = (layout: WorkspaceLayout, surface: SurfaceTab): boolean =>
  [surface.tab.id, ...surface.aliases].some(id => layout.tabs[id] !== undefined);

/** The id the surface is actually open under, if it is. */
const openTabId = (layout: WorkspaceLayout, surface: SurfaceTab): WorkspaceTabId | undefined =>
  [surface.tab.id, ...surface.aliases].find(id => layout.tabs[id] !== undefined);

export function useAgentSurfaceTabs({
  store,
  scope,
  layout,
  opened,
  asked,
  timer = defaultTimer,
  noticeMs = AGENT_SURFACE_NOTICE_MS,
}: AgentSurfaceTabsInput): AgentSurfaceTabs {
  const [unseen, setUnseen] = useState<ReadonlySet<WorkspaceTabId>>(() => new Set());
  const [notice, setNotice] = useState<AgentSurfaceNotice | null>(null);

  // Opened surfaces first, then asks, so a surface opened already asking is a tab before it is forward.
  useEffect(() => {
    const added: { readonly tabId: WorkspaceTabId; readonly text: string }[] = [];
    for (const record of opened) {
      const surface = surfaceTabFor(record);
      const before = store.snapshot(scope);
      if (hasAnnounced(before, openedKey(record))) continue;
      const after = store.update(scope, current =>
        adoptAgentSurface(current, surface.tab, openedKey(record), surface.aliases),
      );
      const open = openTabId(after, surface);
      if (!hasTab(before, surface) && open !== undefined) added.push({ tabId: open, text: noticeText(record) });
    }
    for (const record of asked) {
      const surface = surfaceTabFor(record);
      store.update(scope, current => bringAskedSurfaceForward(current, surface.tab, askKey(record), surface.aliases));
    }
    if (added.length === 0) return;
    setUnseen(current => new Set([...current, ...added.map(entry => entry.tabId)]));
    const last = added[added.length - 1] as (typeof added)[number];
    setNotice(last);
  }, [opened, asked, store, scope]);

  // A tab the owner is looking at is no longer new.
  const focusedTab = focusedWorkspaceTab(layout);
  useEffect(() => {
    setUnseen(current => {
      if (!current.has(focusedTab)) return current;
      const next = new Set(current);
      next.delete(focusedTab);
      return next;
    });
    setNotice(current => (current?.tabId === focusedTab ? null : current));
  }, [focusedTab]);

  // The notice is subtle: it goes by itself.
  const noticeId = notice?.tabId;
  useEffect(() => {
    if (noticeId === undefined) return;
    return timer(() => setNotice(null), noticeMs);
  }, [noticeId, timer, noticeMs]);

  const standingAsks = useMemo(
    () => asked.filter(record => !hasAnnounced(layout, askDoneKey(record))),
    [asked, layout],
  );

  const askedByTab = useMemo(() => {
    const map = new Map<WorkspaceTabId, SurfaceAsked>();
    for (const record of standingAsks) {
      const surface = surfaceTabFor(record);
      map.set(openTabId(layout, surface) ?? surface.tab.id, record);
    }
    return map;
  }, [standingAsks, layout]);

  const reopenable = useMemo(
    () =>
      opened.flatMap(record => {
        const surface = surfaceTabFor(record);
        return hasTab(layout, surface)
          ? []
          : [{ tabId: surface.tab.id, kind: record.surface, label: surface.tab.label }];
      }),
    [opened, layout],
  );

  const dismissNotice = useCallback((): void => setNotice(null), []);
  const showNotice = useCallback((): void => {
    if (notice === null) return;
    store.update(scope, current => activateWorkspaceTab(current, notice.tabId));
    setNotice(null);
  }, [notice, store, scope]);

  const askFor = useCallback(
    (tabId: WorkspaceTabId): AgentSurfaceAsk | null => {
      const record = askedByTab.get(tabId);
      if (record === undefined) return null;
      return {
        agent: record.agentName ?? 'The agent',
        ...(record.message === undefined ? {} : { message: record.message }),
      };
    },
    [askedByTab],
  );

  const dismissAsk = useCallback(
    (tabId: WorkspaceTabId): void => {
      const record = askedByTab.get(tabId);
      if (record === undefined) return;
      store.update(scope, current => markAnnounced(current, askDoneKey(record)));
    },
    [askedByTab, store, scope],
  );

  const reopen = useCallback(
    (tabId: WorkspaceTabId): void => {
      const record = opened.find(candidate => surfaceTabFor(candidate).tab.id === tabId);
      if (record === undefined) return;
      store.update(scope, current => openWorkspaceTab(current, surfaceTabFor(record).tab));
    },
    [opened, store, scope],
  );

  return useMemo(
    () => ({
      unseenTabIds: unseen,
      askedTabIds: new Set(askedByTab.keys()),
      notice,
      dismissNotice,
      showNotice,
      askFor,
      dismissAsk,
      reopenable,
      reopen,
    }),
    [unseen, askedByTab, notice, dismissNotice, showNotice, askFor, dismissAsk, reopenable, reopen],
  );
}
