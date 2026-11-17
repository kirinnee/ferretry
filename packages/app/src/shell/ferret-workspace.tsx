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
import { type ReactNode, useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { cn } from '../ui/lib/class-names.ts';
import { useLayoutMode } from '../ui/hooks/use-layout-mode.ts';
import { FerretWorkspaceActionsProvider } from './ferret-workspace-actions.tsx';
import {
  CHAT_TAB,
  type NewTabChoice,
  newTabChoices,
  panelKey,
  panelPlaced,
  phoneTabs,
  revealPanel,
  tabOrChat,
} from './ferret-workspace-model.ts';
import { phoneChipId, PhoneTabRow } from './phone-tab-row.tsx';
import { sidePaneOpen } from './side-pane-open.ts';
import { PanelSlot, useSlotPanels } from './views.tsx';

const SIDE = 'ferret.side';

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
      if (!panelPlaced(panels, panelId)) return;
      sidePaneOpen.set(true);
      setWanted(panelId);
    },
    [panels],
  );
  const shows = useCallback((panelId: string): boolean => panelPlaced(panels, panelId), [panels]);
  if (!phone || panels.length === 0)
    return (
      <FerretWorkspaceActionsProvider
        canControl={canControl}
        daemon={daemon}
        ferret={subject}
        showPanel={reveal}
        shows={shows}
      >
        <div className="flex min-h-0 min-w-0 flex-1">
          {chat}
          {mounted ? (
            <div id={sideId} style={{ display: open ? 'contents' : 'none' }}>
              <PanelSlot daemon={daemon} slot={SIDE} subject={subject} />
            </div>
          ) : null}
          {panels.length === 0 ? null : <SideToggle controls={sideId} open={open} />}
        </div>
      </FerretWorkspaceActionsProvider>
    );
  return <PhoneWorkspace canControl={canControl} chat={chat} daemon={daemon} subject={subject} />;
}

/** The page's one way to the side column: a slim rail on the right edge holding a single toggle, so a closed column costs 40px. */
function SideToggle({ open, controls }: { readonly open: boolean; readonly controls: string }) {
  const Icon = open ? PanelRightClose : PanelRight;
  return (
    <div
      className={cn('flex w-10 shrink-0 flex-col items-center py-2', open ? '' : 'border-l border-border-soft')}
      data-side-rail=""
    >
      <button
        aria-controls={controls}
        aria-expanded={open}
        aria-label={open ? 'Hide side panels' : 'Show side panels'}
        className="flex h-8 w-8 items-center justify-center rounded-control border border-border-strong bg-surface text-fg hover:bg-surface-2"
        data-side-toggle=""
        onClick={() => sidePaneOpen.set(!open)}
        title={open ? 'Hide side panels' : 'Agenda, queue, tasks, terminals, files…'}
        type="button"
      >
        <Icon aria-hidden="true" size={16} />
      </button>
    </div>
  );
}

function PhoneWorkspace({ daemon, subject, chat, canControl = true }: FerretWorkspaceProps) {
  const panels = useSlotPanels(SIDE);
  const rowId = useId();
  const tabs = phoneTabs(panels);
  const [chosen, setChosen] = useState(CHAT_TAB);
  const active = tabOrChat(tabs, chosen);
  const [intent, setIntent] = useState<PanelIntent | undefined>(undefined);
  const requests = useRef(0);

  const choose = useCallback((choice: NewTabChoice): void => {
    setChosen(choice.panel);
    if (choice.action === undefined) return;
    requests.current += 1;
    setIntent({ id: requests.current, action: choice.action });
  }, []);

  /** A panel of this ferret asks for another one (`files`): its chip becomes the one on show. */
  const showPanel = useCallback(
    (panelId: string): void => {
      const panel = panels.find(candidate => candidate.id === panelId);
      if (panel !== undefined) setChosen(panelKey(panel));
    },
    [panels],
  );
  const shows = useCallback((panelId: string): boolean => panelPlaced(panels, panelId), [panels]);

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
