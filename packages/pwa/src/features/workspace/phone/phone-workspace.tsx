/**
 * THE PHONE WORKSPACE: one thing at a time, with the same model as desktop.
 *
 *   header slot   the session header (the caller's — this file never draws it)
 *   chip row      Chat, Console, Processes, every workspace tab (✕ or a long-press closes one), ＋
 *   body          the active tab, swipe left/right for the neighbours
 *   key bar       esc / tab / ctrl / arrows, on terminal and console tabs only
 *
 * Every tab stays MOUNTED and only the active one is shown: a terminal or remote
 * browser that reconnected each time the reader swiped past it would lose its
 * scrollback and its stream. The caller decides what each tab renders through
 * `renderTab`; terminal tabs are handed the sticky-ctrl filter for their typed
 * input, because ctrl armed on the bar must modify the next key typed on the
 * phone keyboard too.
 */

import { type ReactNode, useCallback, useId, useRef } from 'react';
import { useKeyboardOpen } from '../../../hooks/use-keyboard-open.ts';
import {
  PhoneChipRow,
  type PhoneCloseTabActions,
  type PhoneNewTabActions,
  phoneChipId,
  phonePanelId,
} from './phone-chip-row.tsx';
import { adjacentPhoneTab, PHONE_CHAT_TAB, type PhoneTab, phoneTabOrder, phoneTabTakesKeys } from './phone-tab.ts';
import { TerminalKeyBar, useStickyCtrl } from './terminal-key-bar.tsx';
import { useTabSwipe } from './use-tab-swipe.ts';

export interface PhoneTabRenderContext {
  readonly active: boolean;
  /** Pass typed terminal input through this before sending it: it applies an armed ctrl. */
  readonly interceptInput: (data: string) => string;
}

export interface PhoneWorkspaceProps extends PhoneNewTabActions, PhoneCloseTabActions {
  /** The header, drawn above the chip row. */
  readonly header?: ReactNode;
  /** Workspace tabs only — Chat, Console and Processes are always added in front. */
  readonly tabs: readonly PhoneTab[];
  readonly activeId: string;
  readonly onSelect: (tabId: string) => void;
  readonly renderTab: (tab: PhoneTab, context: PhoneTabRenderContext) => ReactNode;
  /** Key-bar bytes for a terminal-like tab. */
  readonly onTerminalInput: (tabId: string, data: string) => void;
  /** Focus a terminal-like tab's input so the phone keyboard opens. */
  readonly onFocusTerminal: (tabId: string) => void;
  /**
   * False for a host whose Console cannot take typed keys, so it gets no key bar that would send
   * nowhere. The session page's Console types through `/console/input`; terminals always get one.
   */
  readonly consoleTakesKeys?: boolean;
  /** The Processes chip, when the host labels it with a live count ("Processes · 3"). */
  readonly processesTab?: PhoneTab;
}

export function PhoneWorkspace({
  header,
  tabs,
  activeId,
  onSelect,
  renderTab,
  onTerminalInput,
  onFocusTerminal,
  consoleTakesKeys = true,
  processesTab,
  ...actions
}: PhoneWorkspaceProps) {
  const rowId = useId();
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const order = phoneTabOrder(tabs, processesTab);
  const active = order.find(tab => tab.id === activeId) ?? PHONE_CHAT_TAB;
  const keyboardOpen = useKeyboardOpen();
  const { ctrl, setCtrl, intercept } = useStickyCtrl();

  const onSwipe = useCallback(
    (direction: 'next' | 'previous') => {
      const next = adjacentPhoneTab(order, active.id, direction);
      if (next) onSelect(next.id);
    },
    [order, active.id, onSelect],
  );
  useTabSwipe(bodyRef, { enabled: true, onSwipe });

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-bg" data-phone-workspace="">
      {header}
      <PhoneChipRow rowId={rowId} tabs={order} activeId={active.id} onSelect={onSelect} {...actions} />
      <div ref={bodyRef} className="relative flex min-h-0 flex-1 flex-col" data-phone-workspace-body="">
        {order.map(tab => (
          <div
            key={tab.id}
            role="tabpanel"
            id={phonePanelId(rowId, tab.id)}
            aria-labelledby={phoneChipId(rowId, tab.id)}
            hidden={tab.id !== active.id}
            // A class `display` beats the user-agent `[hidden]` rule, so the hidden panel takes no
            // display class at all: otherwise every tab stacks under the active one.
            className={tab.id === active.id ? 'flex min-h-0 flex-1 flex-col' : 'min-h-0 flex-1 flex-col'}
          >
            {renderTab(tab, { active: tab.id === active.id, interceptInput: intercept })}
          </div>
        ))}
      </div>
      {phoneTabTakesKeys(active.kind) && (consoleTakesKeys || active.kind !== 'console') && (
        <TerminalKeyBar
          onSend={data => onTerminalInput(active.id, data)}
          ctrl={ctrl}
          onCtrlChange={setCtrl}
          onKeyboard={() => onFocusTerminal(active.id)}
          keyboardOpen={keyboardOpen}
        />
      )}
    </div>
  );
}
