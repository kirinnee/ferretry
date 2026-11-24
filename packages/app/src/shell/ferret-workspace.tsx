/**
 * THE FERRET PAGE'S BODY: the chat, and the `ferret.side` panels the layout places beside it.
 *
 * Wide, the page is the chat and the composer, as v4's was: the side column (agenda, queue, tasks, terminals, files…) is
 * CLOSED until the reader opens it from the small toggle on the page's right edge, and what they chose lasts for the visit
 * (`side-pane-open.ts`). Open, it sits beside the chat (its own scrolling column, `shell.css`). A PHONE has no room beside a chat,
 * and the one host the panels have is the page, so below 768px the page is v4's PhoneWorkspace again: one thing at a time,
 * full width, behind a row of chips (Chat, Console, Processes, Terminals, Browser, Files…) and a "+" that opens New terminal /
 * New browser / Open file (`ferret-workspace-model.ts`). It is the SAME providers: every panel stays mounted in the same
 * `PanelSlot` and only the one on show is drawn, so a terminal keeps its stream while the chat is on screen. "+" asks the
 * panel that owns the act (`PanelIntent`) rather than holding a second list of terminals or pages.
 */

import type { PanelIntent } from '@ferretry/kernel/manifest';
import { PanelRight, PanelRightClose } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ResizeHandle } from '../ui/resize-handle.tsx';
import { useLayoutMode } from '../ui/hooks/use-layout-mode.ts';
import { useAppHook } from './app-hooks.ts';
import { FerretWorkspaceActionsProvider } from './ferret-workspace-actions.tsx';
import {
  addressNamesFile,
  CHAT_TAB,
  type NewTabChoice,
  newTabChoices,
  panelKey,
  panelPlaced,
  phoneTabs,
  revealPanel,
  sideTabOrFirst,
  sideTabs,
  tabOrChat,
} from './ferret-workspace-model.ts';
import { phoneChipId, PhoneTabRow } from './phone-tab-row.tsx';
import { usePanelReveal } from './panel-reveal.ts';
import { sidePaneOpen } from './side-pane-open.ts';
import { PanelSlot, useSlotPanels } from './views.tsx';

const SIDE = 'ferret.side';

/**
 * `ferrets.needs-you`: the hook Ferrets OFFERS and the plugin holding the asks provides (`core/ferrets/contract/app-hooks/
 * needs-you.app-hook.ts` owns the name and the shape; the app does not depend on that package, so it narrows the value
 * itself, as every taker of an app hook does). `needing()` maps a ferret id to its entry; Agenda's entries also say how many
 * items are on the OWNER's turn (`waitingOnOwner`, the number the agenda line's pill shows) and whether this ferret's chat
 * draws that line (`lineShown`, agenda mode on).
 */
const NEEDS_YOU_HOOK = 'ferrets.needs-you';
interface NeedsYouHook {
  readonly subscribe: (listener: () => void) => () => void;
  readonly watch: () => () => void;
  readonly needing: () => ReadonlyMap<string, { readonly waitingOnOwner?: number; readonly lineShown?: boolean }>;
}
const isNeedsYouHook = (value: unknown): value is NeedsYouHook =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as NeedsYouHook).subscribe === 'function' &&
  typeof (value as NeedsYouHook).watch === 'function' &&
  typeof (value as NeedsYouHook).needing === 'function';
const noSubscription = (): (() => void) => () => undefined;
const nothing = (): number => 0;

/**
 * HOW MANY ASKS WAIT ON THE OWNER IN THIS FERRET: what the closed side column hides. With Agenda mode off the chat draws no
 * agenda line above the composer, so the asks live only in the side tab; the toggle carries the count instead. With the line
 * drawn the toggle says nothing (the same asks would show twice). Only items on the owner's turn count: the pill's number.
 * 0 with no provider (Agenda off or not installed on that machine).
 */
function useWaitingAsks(daemon: string, subject: string): number {
  const hook = useAppHook(daemon, NEEDS_YOU_HOOK);
  const needsYou = isNeedsYouHook(hook) ? hook : undefined;
  useEffect(() => needsYou?.watch(), [needsYou]);
  const read = useCallback(() => {
    const entry = needsYou?.needing().get(subject);
    return entry === undefined || entry.lineShown !== false ? 0 : (entry.waitingOnOwner ?? 0);
  }, [needsYou, subject]);
  return useSyncExternalStore(needsYou?.subscribe ?? noSubscription, read, nothing);
}

/**
 * WHAT "+" ASKS OF A PANEL, shared by the phone's chip row and the wide column's tab row: choosing a choice shows the panel that
 * owns the act (`select`) and, when the act is not just showing it, hands that panel a numbered `PanelIntent`.
 */
function usePanelIntent(select: (key: string) => void) {
  const [intent, setIntent] = useState<PanelIntent | undefined>(undefined);
  const requests = useRef(0);
  const choose = useCallback(
    (choice: NewTabChoice): void => {
      select(choice.panel);
      if (choice.action === undefined) return;
      requests.current += 1;
      setIntent({ id: requests.current, action: choice.action });
    },
    [select],
  );
  /** A panel asked to be shown (`panel-reveal.ts`): the same numbered request, with what it is about. */
  const ask = useCallback((request: Pick<PanelIntent, 'action' | 'target'>): void => {
    requests.current += 1;
    setIntent({ id: requests.current, ...request });
  }, []);
  return { intent, choose, ask };
}

export interface FerretWorkspaceProps {
  readonly daemon: string;
  /** The ferret the panels are drawn for. */
  readonly subject: string;
  /** The conversation. */
  readonly chat: ReactNode;
  /** Whether this connection may control the ferret; the panels read it (`useFerretWorkspace`). Defaults to true. */
  readonly canControl?: boolean;
}

export function FerretWorkspace({ daemon, subject, chat, canControl = true }: FerretWorkspaceProps) {
  const panels = useSlotPanels(SIDE);
  const phone = useLayoutMode() === 'drawer';
  const sideId = useId();
  const open = useSyncExternalStore(sidePaneOpen.subscribe, sidePaneOpen.get, sidePaneOpen.get);
  // Panels mount the first time the column opens and then stay mounted (a terminal keeps its stream behind a closed column).
  const [mounted, setMounted] = useState(open);
  const [wanted, setWanted] = useState<string | undefined>(undefined);
  // Beside the chat the open column shows ONE panel at a time behind a row of tabs (Console, Terminals, Browser…).
  const rowId = useId();
  const tabs = useMemo(() => sideTabs(panels), [panels]);
  const [chosenTab, setChosenTab] = useState<string | undefined>(undefined);
  const activeTab = sideTabOrFirst(tabs, chosenTab);
  const { intent, choose, ask } = usePanelIntent(setChosenTab);
  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);
  // A panel asked for while the column is closed opens it, then scrolls to the panel once it is drawn.
  useEffect(() => {
    if (wanted === undefined || !open || !mounted) return;
    revealPanel(panels, wanted);
    setWanted(undefined);
  }, [wanted, open, mounted, panels]);
  const reveal = useCallback(
    (panelId: string): void => {
      const panel = panels.find(candidate => candidate.id === panelId);
      if (panel === undefined) return;
      setChosenTab(panelKey(panel));
      sidePaneOpen.set(true);
      setWanted(panelId);
    },
    [panels],
  );
  const shows = useCallback((panelId: string): boolean => panelPlaced(panels, panelId), [panels]);
  // A panel that asks to be shown (the agent opened a browser page) opens the column on it and hands it the request.
  usePanelReveal({
    daemon,
    subject,
    panels,
    phone: false,
    enabled: !phone || panels.length === 0,
    shown: open ? activeTab : undefined,
    onShow: useCallback(
      (panel, request) => {
        reveal(panel.id);
        ask(request);
      },
      [reveal, ask],
    ),
  });
  // An address that names a file (`?file=`, from Projects' file finder) opens the closed side column on Files, once.
  const fileWanted = useRef(addressNamesFile(globalThis.location?.search ?? ''));
  useEffect(() => {
    if (!fileWanted.current || (phone && panels.length > 0) || !panelPlaced(panels, 'files')) return;
    fileWanted.current = false;
    reveal('files');
  }, [phone, panels, reveal]);
  if (!phone || panels.length === 0)
    return (
      <FerretWorkspaceActionsProvider
        canControl={canControl}
        daemon={daemon}
        ferret={subject}
        showPanel={reveal}
        shows={shows}
      >
        <div className="fy-ferret-frame flex min-h-0 min-w-0 flex-1">
          <div className="fy-ferret-row flex min-h-0 min-w-0 flex-1">
            {chat}
            {panels.length === 0 ? null : open ? (
              <ResizeHandle edge="start" label="side panel" panel="ferret-side" />
            ) : null}
            {panels.length > 0 && (mounted || open) ? (
              <aside
                aria-label="Ferret side panel"
                className="fy-ferret-side"
                data-ferret-side=""
                id={sideId}
                style={open ? undefined : { display: 'none' }}
              >
                <PhoneTabRow
                  active={activeTab}
                  choices={newTabChoices(panels)}
                  label="Side panel tabs"
                  onChoose={choose}
                  onSelect={setChosenTab}
                  rowId={rowId}
                  tabs={tabs}
                  trailing={<SideToggle controls={sideId} daemon={daemon} open={true} subject={subject} />}
                />
                <PanelSlot
                  daemon={daemon}
                  phone={{ active: activeTab, labelledBy: key => phoneChipId(rowId, key) }}
                  slot={SIDE}
                  subject={subject}
                  {...(intent === undefined ? {} : { props: { intent } })}
                />
              </aside>
            ) : null}
            {panels.length === 0 || open ? null : (
              <SideToggle controls={sideId} daemon={daemon} open={false} subject={subject} />
            )}
          </div>
        </div>
      </FerretWorkspaceActionsProvider>
    );
  return <PhoneWorkspace canControl={canControl} chat={chat} daemon={daemon} subject={subject} />;
}

/** The page's one way to the side column: a slim rail on the right edge holding a single toggle, so a closed column costs 40px. */
function SideToggle({
  open,
  controls,
  daemon,
  subject,
}: {
  readonly open: boolean;
  readonly controls: string;
  readonly daemon: string;
  readonly subject: string;
}) {
  const Icon = open ? PanelRightClose : PanelRight;
  // Only a CLOSED column hides the asks: open, the agenda tab is on screen and says them itself.
  const waiting = useWaitingAsks(daemon, subject);
  const count = open ? 0 : waiting;
  const button = (
    <button
      aria-controls={controls}
      aria-expanded={open}
      aria-label={
        open
          ? 'Hide side panels'
          : count === 0
            ? 'Show side panels'
            : `Show side panels, ${count} ${count === 1 ? 'ask waits' : 'asks wait'} on you`
      }
      className="relative flex h-8 w-8 items-center justify-center rounded-control text-muted transition-colors hover:bg-surface-2 hover:text-fg"
      data-waiting={count === 0 ? undefined : count}
      data-side-toggle=""
      onClick={() => sidePaneOpen.set(!open)}
      title={open ? 'Hide side panels' : 'Console, agenda, queue, tasks, terminals, files…'}
      type="button"
    >
      <Icon aria-hidden="true" size={16} />
      {count === 0 ? null : (
        <span aria-hidden="true" className="fy-side-toggle__count" data-side-toggle-count="">
          {count > 99 ? '99+' : count}
        </span>
      )}
    </button>
  );
  // Open, the button sits at the end of the tab row; closed, it is the one thing on a slim rail at the page's edge.
  return open ? (
    button
  ) : (
    <div className="flex w-10 shrink-0 flex-col items-center border-l border-border-soft py-2" data-side-rail="">
      {button}
    </div>
  );
}

function PhoneWorkspace({ daemon, subject, chat, canControl = true }: FerretWorkspaceProps) {
  const panels = useSlotPanels(SIDE);
  const rowId = useId();
  const tabs = phoneTabs(panels);
  const [chosen, setChosen] = useState(CHAT_TAB);
  const active = tabOrChat(tabs, chosen);
  const { intent, choose, ask } = usePanelIntent(setChosen);

  /** A panel of this ferret asks for another one (`files`): its chip becomes the one on show. */
  const showPanel = useCallback(
    (panelId: string): void => {
      const panel = panels.find(candidate => candidate.id === panelId);
      if (panel !== undefined) setChosen(panelKey(panel));
    },
    [panels],
  );
  const shows = useCallback((panelId: string): boolean => panelPlaced(panels, panelId), [panels]);
  // A panel that asks to be shown moves to its chip, unless a sign-in card modal is open (`panel-reveal.ts`).
  usePanelReveal({
    daemon,
    subject,
    panels,
    phone: true,
    enabled: true,
    shown: active === CHAT_TAB ? undefined : active,
    onShow: useCallback(
      (panel, request) => {
        showPanel(panel.id);
        ask(request);
      },
      [showPanel, ask],
    ),
  });
  // An address that names a file (`?file=`) lands on the Files chip, once.
  const fileWanted = useRef(addressNamesFile(globalThis.location?.search ?? ''));
  useEffect(() => {
    if (!fileWanted.current || !panelPlaced(panels, 'files')) return;
    fileWanted.current = false;
    showPanel('files');
  }, [panels, showPanel]);

  return (
    <FerretWorkspaceActionsProvider
      canControl={canControl}
      daemon={daemon}
      ferret={subject}
      showPanel={showPanel}
      shows={shows}
    >
      <PhoneTabRow
        active={active}
        choices={newTabChoices(panels)}
        onChoose={choose}
        onSelect={setChosen}
        rowId={rowId}
        tabs={tabs}
      />
      <div className="flex min-h-0 min-w-0 flex-1" data-phone-tab={active} data-phone-workspace="">
        {/* The chat stays mounted behind another tab: its transcript keeps its place and its stream. */}
        <div
          aria-labelledby={phoneChipId(rowId, CHAT_TAB)}
          className="flex min-h-0 min-w-0 flex-1"
          data-phone-chat=""
          role="tabpanel"
          style={active === CHAT_TAB ? undefined : { display: 'none' }}
        >
          {chat}
        </div>
        <PanelSlot
          daemon={daemon}
          phone={{ active: active === CHAT_TAB ? undefined : active, labelledBy: key => phoneChipId(rowId, key) }}
          slot={SIDE}
          subject={subject}
          {...(intent === undefined ? {} : { props: { intent } })}
        />
      </div>
    </FerretWorkspaceActionsProvider>
  );
}
