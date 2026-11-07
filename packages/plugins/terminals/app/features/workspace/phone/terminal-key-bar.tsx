/**
 * THE KEYS A PHONE KEYBOARD DOES NOT HAVE: esc, tab, ctrl and the arrows, in a
 * bar that sits directly above the on-screen keyboard on a terminal tab.
 *
 * It needs no positioning of its own to stay above the keyboard: the app shell
 * is sized from the visual viewport (`--app-h`, `use-app-viewport.ts`), so the
 * bottom of the workspace column already IS the top of the keyboard, exactly as
 * for the chat composer.
 *
 * Every key keeps focus where it is. Tapping a button normally blurs the
 * terminal's input, which dismisses the phone keyboard after every keystroke;
 * cancelling the pointer-down default stops that, so the reader can tap ↑ three
 * times without the keyboard bouncing.
 *
 * ctrl is sticky (see `terminal-keys.ts`) and its state is the caller's, because
 * the key it modifies may be typed on the phone keyboard rather than tapped here.
 *
 * ALL EIGHT CONTROLS FIT A 390px PHONE. They used to keep their own widths and the keyboard toggle — the
 * one a reader needs most — ran off the right edge. Below `sm` every key now takes an equal share of the
 * row (never under the 44px target floor), the gaps and padding tighten, and the toggle is its icon alone,
 * named by its `aria-label`.
 */

import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Keyboard, type LucideIcon } from 'lucide-react';
import { useCallback, useState } from 'react';
import { cn } from '../../../lib/class-names.ts';
import { applyStickyCtrl, type TerminalBarKey, terminalKeySequence } from './terminal-keys.ts';

const KEYS: readonly { readonly key: TerminalBarKey; readonly label: string; readonly icon?: LucideIcon }[] = [
  { key: 'esc', label: 'esc' },
  { key: 'tab', label: 'tab' },
  { key: 'up', label: 'Up arrow', icon: ArrowUp },
  { key: 'down', label: 'Down arrow', icon: ArrowDown },
  { key: 'left', label: 'Left arrow', icon: ArrowLeft },
  { key: 'right', label: 'Right arrow', icon: ArrowRight },
];

/** Sticky ctrl as state: arm it, spend it on the next key, from either keyboard. */
export interface StickyCtrl {
  readonly ctrl: boolean;
  readonly setCtrl: (armed: boolean) => void;
  /** Typed input from the terminal: returns what to send and disarms. */
  readonly intercept: (data: string) => string;
}

export function useStickyCtrl(): StickyCtrl {
  const [ctrl, setCtrl] = useState(false);
  const intercept = useCallback(
    (data: string): string => {
      if (!ctrl) return data;
      setCtrl(false);
      return applyStickyCtrl(data, true);
    },
    [ctrl],
  );
  return { ctrl, setCtrl, intercept };
}

export interface TerminalKeyBarProps {
  /** Bytes for the terminal stream. */
  readonly onSend: (data: string) => void;
  readonly ctrl: boolean;
  readonly onCtrlChange: (armed: boolean) => void;
  /** Focus the terminal's own input so the phone keyboard opens. */
  readonly onKeyboard: () => void;
  /** Whether the phone keyboard is up — the keyboard key reads as pressed. */
  readonly keyboardOpen: boolean;
}

const KEY_CLASS =
  'flex min-h-control min-w-0 flex-1 items-center justify-center gap-xs rounded-control border px-0 font-mono text-ui transition-colors sm:min-w-[var(--control-h)] sm:flex-none sm:shrink-0 sm:px-control-x';

const keepFocus = (event: { preventDefault: () => void }): void => event.preventDefault();

export function TerminalKeyBar({ onSend, ctrl, onCtrlChange, onKeyboard, keyboardOpen }: TerminalKeyBarProps) {
  const press = (key: TerminalBarKey): void => {
    onSend(terminalKeySequence(key, ctrl));
    if (ctrl) onCtrlChange(false);
  };
  return (
    <div
      role="toolbar"
      aria-label="Terminal keys"
      data-safe-bottom=""
      data-tab-swipe-ignore=""
      className="flex items-center gap-0.5 overflow-x-auto border-t border-border-soft bg-surface px-1 pt-xs [--own-pad-bottom:var(--gap-xs)] [scrollbar-width:none] sm:gap-xs sm:px-panel [&::-webkit-scrollbar]:hidden"
    >
      <button
        type="button"
        aria-pressed={ctrl}
        onPointerDown={keepFocus}
        onClick={() => onCtrlChange(!ctrl)}
        className={cn(
          KEY_CLASS,
          ctrl ? 'border-accent bg-accent-soft text-accent' : 'border-border-soft bg-surface-2 text-fg',
        )}
      >
        ctrl
      </button>
      {KEYS.map(({ key, label, icon: Icon }) => (
        <button
          key={key}
          type="button"
          aria-label={Icon ? label : undefined}
          data-terminal-key={key}
          onPointerDown={keepFocus}
          onClick={() => press(key)}
          className={cn(KEY_CLASS, 'border-border-soft bg-surface-2 text-fg')}
        >
          {Icon ? <Icon size={15} aria-hidden="true" /> : label}
        </button>
      ))}
      <button
        type="button"
        aria-pressed={keyboardOpen}
        aria-label="keyboard"
        onPointerDown={keepFocus}
        onClick={onKeyboard}
        className={cn(KEY_CLASS, 'border-border-soft bg-surface-2 text-fg sm:ml-auto')}
      >
        <Keyboard size={15} aria-hidden="true" />
        <span aria-hidden="true" className="hidden font-ui sm:inline">
          keyboard
        </span>
      </button>
    </div>
  );
}
