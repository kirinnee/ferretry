/**
 * The phone key bar's wiring, in one place: where a terminal view draws on a phone, the keys a phone keyboard does
 * not have (esc, tab, ctrl, arrows) sit directly above the on-screen keyboard (today's `phone-workspace.tsx`).
 *
 * The view hands back a port it can be typed into and focused through (`onInputPort`), and takes the sticky-ctrl
 * filter for what the reader types (`interceptInput`), because ctrl armed on the bar must modify the next key typed
 * on the phone keyboard. The bar is drawn only on a phone — the drawer layout, today's `useLayoutMode` — and only
 * while the view has given its port, so there is never a bar with nothing behind it.
 */

import { useKeyboardOpen, useLayoutMode } from '@ferretry/app/ui';
import { useCallback, useState } from 'react';
import type { TerminalInputPort } from '../../../components/session-terminal-deck.tsx';
import { TerminalKeyBar, useStickyCtrl } from './terminal-key-bar.tsx';

export interface PhoneKeyBar {
  /** Pass typed input through this before sending it: it applies an armed ctrl. */
  readonly interceptInput: (data: string) => string;
  /** Hand this to the view: the bar types and focuses through the port it gives. */
  readonly onInputPort: (port: TerminalInputPort | null) => void;
  /** The bar, or `null` where it is not drawn (not a phone, or the view has no port yet). */
  readonly bar: React.ReactNode;
}

export function usePhoneKeyBar(): PhoneKeyBar {
  const phone = useLayoutMode() === 'drawer';
  const keyboardOpen = useKeyboardOpen();
  const { ctrl, setCtrl, intercept } = useStickyCtrl();
  const [port, setPort] = useState<TerminalInputPort | null>(null);
  const onInputPort = useCallback((next: TerminalInputPort | null) => setPort(next), []);
  const bar =
    phone && port !== null ? (
      <TerminalKeyBar
        ctrl={ctrl}
        keyboardOpen={keyboardOpen}
        onCtrlChange={setCtrl}
        onKeyboard={() => port.focus()}
        onSend={data => port.write(data)}
      />
    ) : null;
  return { interceptInput: intercept, onInputPort, bar };
}
