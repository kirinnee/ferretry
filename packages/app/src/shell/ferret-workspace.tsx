/**
 * THE FERRET PAGE'S BODY: the chat, and the `ferret.side` panels the layout places beside it.
 *
 * Wide, they sit side by side (the side column is its own scrolling column, `shell.css`). A PHONE has no room beside a chat,
 * and the one host the panels have is the page, so below 768px the page is v4's PhoneWorkspace again: one thing at a time,
 * full width, behind a row of chips (Chat, Console, Processes, Terminals, Browser, Files…) and a "+" that opens New terminal /
 * New browser / Open file (`ferret-workspace-model.ts`). It is the SAME providers: every panel stays mounted in the same
 * `PanelSlot` and only the one on show is drawn, so a terminal keeps its stream while the chat is on screen. "+" asks the
 * panel that owns the act (`PanelIntent`) rather than holding a second list of terminals or pages.
 */

import type { PanelIntent } from '@ferretry/kernel/manifest';
import { type ReactNode, useCallback, useId, useRef, useState } from 'react';
import { useLayoutMode } from '../ui/hooks/use-layout-mode.ts';
import { CHAT_TAB, type NewTabChoice, newTabChoices, phoneTabs, tabOrChat } from './ferret-workspace-model.ts';
import { phoneChipId, PhoneTabRow } from './phone-tab-row.tsx';
import { PanelSlot, useSlotPanels } from './views.tsx';

const SIDE = 'ferret.side';

export interface FerretWorkspaceProps {
  readonly daemon: string;
  /** The ferret the panels are drawn for. */
  readonly subject: string;
  /** The conversation. */
  readonly chat: ReactNode;
}

export function FerretWorkspace({ daemon, subject, chat }: FerretWorkspaceProps) {
  const panels = useSlotPanels(SIDE);
  const phone = useLayoutMode() === 'drawer';
  if (!phone || panels.length === 0)
    return (
      <div className="flex min-h-0 min-w-0 flex-1">
        {chat}
        <PanelSlot daemon={daemon} slot={SIDE} subject={subject} />
      </div>
    );
  return <PhoneWorkspace chat={chat} daemon={daemon} subject={subject} />;
}

function PhoneWorkspace({ daemon, subject, chat }: FerretWorkspaceProps) {
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

  return (
    <>
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
    </>
  );
}
