/**
 * THE PAGE THEME SWITCH. Copied from today's PWA `shell/theme-toggle.tsx` (kteam `ThemeToggle.tsx`), reading this
 * device's theme from the device context (`useDeviceTheme`, shell contract S9) instead of a module-wide store, so it
 * works on a daemon-less screen and a per-daemon screen alike and a switch here is what Settings shows.
 *
 * Its trigger opens a popover with the theme families and an explicit Auto / Light / Dark control. IT MUST ALWAYS
 * CLOSE: the ✕ in its header, Done, Escape, a tap or click on the scrim around it, and the platform Back
 * (`useBackDismiss`). Choosing a family or a mode does NOT close it — those are two choices — Done does.
 *
 * The family previews are the real thing: each swatch carries `data-swatch="<family>-<mode>"`, and `styles/themes.css`
 * declares that theme's tokens on `[data-swatch=…]`, so a swatch renders in the theme it advertises while the rest of
 * the app stays in the current one. Nothing here hardcodes a colour.
 */
import { Check, Monitor, Moon, Palette, Sun, X } from 'lucide-react';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { type DeviceTheme, useDeviceTheme } from '../shell/device-context.tsx';
import type { ResolvedMode, ThemeMode } from '../theme/preferences.ts';
import { useBackDismiss } from './hooks/use-back-dismiss.ts';
import { isTopEscapeLayer, pushEscapeLayer } from './hooks/use-dialog-focus.ts';
import { useKeyboardOpen } from './hooks/use-keyboard-open.ts';
import { useLayoutMode } from './hooks/use-layout-mode.ts';
import { cn } from './lib/class-names.ts';
import { Button } from './primitives.tsx';

/** Everything the browser can put focus on inside the panel; the `tabIndex >= 0` filter below picks the TAB STOPS. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]';

export const MODE_OPTIONS: readonly {
  readonly id: ThemeMode;
  readonly label: string;
  readonly Icon: typeof Sun;
  readonly hint: string;
}[] = [
  { id: 'system', label: 'Auto', Icon: Monitor, hint: 'Follow the operating system' },
  { id: 'light', label: 'Light', Icon: Sun, hint: 'Always light' },
  { id: 'dark', label: 'Dark', Icon: Moon, hint: 'Always dark' },
];

/** The list is capped and scrollable, so its cards keep their natural height instead of being flex-compressed. */
const THEME_FAMILY_CARD_CLASS =
  'flex w-full shrink-0 flex-col gap-1 rounded-panel border p-panel text-left transition-colors';

/** Reveal one family card inside the picker's own scrollport — never `scrollIntoView()`, which walks the shell too. */
export function scrollThemeFamilyIntoView(scroller: HTMLElement, target: HTMLElement): void {
  const viewport = scroller.getBoundingClientRect();
  const card = target.getBoundingClientRect();
  if (card.top < viewport.top) scroller.scrollTop += card.top - viewport.top;
  else if (card.bottom > viewport.bottom) scroller.scrollTop += card.bottom - viewport.bottom;
}

/** A live, CSS-only preview of one family/mode pair. */
export function Swatch({ theme, current }: { readonly theme: string; readonly current: boolean }) {
  return (
    <span
      className={cn(
        'block min-w-0 flex-1 rounded-sm',
        current && 'ring-2 ring-accent ring-offset-1 ring-offset-surface',
      )}
    >
      <span className="kt-swatch" data-swatch={theme} aria-hidden="true">
        <span className="kt-swatch-mini">
          <span className="kt-swatch-header">Aa</span>
          <span className="kt-swatch-row">
            <i />
            <i />
            <i />
          </span>
        </span>
        <i className="kt-swatch-accent" />
        <i className="kt-swatch-signal" />
      </span>
    </span>
  );
}

/** The theme controls inside the popover. */
function ThemeSettings({
  theme,
  listRef,
}: {
  readonly theme: DeviceTheme;
  readonly listRef: RefObject<HTMLDivElement | null>;
}) {
  const { preference, resolved, families, setFamily, setMode } = theme;
  const { family, mode } = preference;
  // Two pickers can be mounted at once, and two radio groups sharing a `name` would fight over which is checked.
  const group = useId();

  // The radio is visually hidden; the CARD around it is what the reader looks for, so the geometry comes from there.
  const revealFamily = useCallback(
    (control: HTMLElement) => {
      const card = control.closest<HTMLElement>('[data-family-card]') ?? control;
      const list = listRef.current;
      if (list) scrollThemeFamilyIntoView(list, card);
    },
    [listRef],
  );

  // A family change also changes fonts and spacing: recheck on the next frame, once the root theme is published.
  useEffect(() => {
    const target = listRef.current?.querySelector<HTMLInputElement>(`[data-family="${family}"]`);
    if (!target || document.activeElement !== target) return;
    const frame = requestAnimationFrame(() => {
      if (target.isConnected && document.activeElement === target) revealFamily(target);
    });
    return () => cancelAnimationFrame(frame);
  }, [listRef, family, revealFamily]);

  const onListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const keys = ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const index = families.findIndex(option => option.id === family);
    const last = families.length - 1;
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? last
          : event.key === 'ArrowDown' || event.key === 'ArrowRight'
            ? Math.min(last, index + 1)
            : Math.max(0, index - 1);
    const target = families[next];
    const targetControl =
      target === undefined ? null : listRef.current?.querySelector<HTMLInputElement>(`[data-family="${target.id}"]`);
    if (target === undefined || !targetControl) return;
    setFamily(target.id);
    // Own the scroll explicitly: `focus()` would scroll engine-dependently and can move the fixed shell.
    targetControl.focus({ preventScroll: true });
    revealFamily(targetControl);
  };

  return (
    <>
      {/* `relative` on both groups is LOAD-BEARING: each option's radio is `sr-only` (absolute), and without a
      positioned group its containing block is the fixed shell, which focusing it would scroll out of view. */}
      <div
        role="radiogroup"
        aria-label="Colour mode"
        className="relative mb-2 flex gap-1 rounded-control border border-border bg-surface-2 p-1"
      >
        {MODE_OPTIONS.map(({ id, label, Icon, hint }) => {
          const checked = mode === id;
          return (
            <label
              key={id}
              title={hint}
              className={cn(
                'flex h-control-sm flex-1 cursor-pointer items-center justify-center gap-1 rounded-tab px-control-x text-meta font-medium transition-colors',
                'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent',
                checked
                  ? 'border border-accent bg-accent-soft text-accent'
                  : 'border border-transparent text-muted hover:text-fg',
              )}
            >
              <input
                type="radio"
                name={`${group}-mode`}
                data-mode={id}
                value={id}
                checked={checked}
                tabIndex={checked ? 0 : -1}
                onChange={() => setMode(id)}
                className="sr-only"
              />
              <Icon size={12} aria-hidden="true" />
              {label}
            </label>
          );
        })}
      </div>
      <div
        ref={listRef}
        role="radiogroup"
        aria-label="Theme family"
        onKeyDown={onListKeyDown}
        className="relative flex max-h-[min(60vh,420px)] flex-col gap-1.5 overflow-y-auto scroll-thin"
      >
        {families.map(option => {
          const checked = option.id === family;
          return (
            <label
              key={option.id}
              data-family-card={option.id}
              className={cn(
                THEME_FAMILY_CARD_CLASS,
                'cursor-pointer has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent',
                checked ? 'border-accent bg-accent-soft' : 'border-border bg-surface hover:border-accent',
              )}
            >
              <input
                type="radio"
                name={`${group}-family`}
                data-family={option.id}
                value={option.id}
                checked={checked}
                aria-label={`${option.label} — ${option.blurb}`}
                tabIndex={checked ? 0 : -1}
                onChange={() => setFamily(option.id)}
                className="sr-only"
              />
              <span className="flex items-center gap-1">
                <span className="text-ui font-semibold text-fg">{option.label}</span>
                {checked && <Check size={12} className="text-accent" aria-hidden="true" />}
              </span>
              <span className="text-meta leading-base text-muted">{option.blurb}</span>
              <span className="mt-1 flex items-stretch gap-1.5">
                {(['light', 'dark'] as readonly ResolvedMode[]).map(variant => (
                  <Swatch key={variant} theme={`${option.id}-${variant}`} current={checked && resolved === variant} />
                ))}
              </span>
            </label>
          );
        })}
      </div>
      <p className="mt-2 border-t border-border-soft pt-1.5 text-2xs leading-base text-faint">
        Previews render in their own theme. Auto follows the OS live.
      </p>
    </>
  );
}

/** The trigger (the icon alone, its name the tooltip) and its popover. */
function ThemeToggle({ theme }: { readonly theme: DeviceTheme }) {
  const { preference, resolved, families } = theme;
  const { family, mode } = preference;
  const [open, setOpen] = useState(false);
  const keyboardOpen = useKeyboardOpen();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  /** This popover's identity in the shared overlay stack, stable for the component's life. */
  const layer = useRef<object>({});

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);
  const dismissForBack = useCallback(() => close(false), [close]);
  useBackDismiss(open, dismissForBack);

  // Escape closes and hands focus back; a press outside just closes. Only the TOP overlay layer answers either.
  useEffect(() => {
    if (!open) return;
    const token = layer.current;
    const release = pushEscapeLayer(token);
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !isTopEscapeLayer(token)) return;
      event.stopPropagation();
      close(true);
    };
    const onPointerDown = (event: MouseEvent) => {
      if (!isTopEscapeLayer(token)) return;
      if (!rootRef.current?.contains(event.target as Node)) close(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointerDown);
      release();
    };
  }, [open, close]);

  // The switch can sit in chrome a software keyboard hides: close first, without moving focus to a hidden trigger.
  useEffect(() => {
    if (open && keyboardOpen) close(false);
  }, [open, keyboardOpen, close]);

  // Opening puts focus on the family in force, so the popover is usable without a pointer.
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLInputElement>('input[data-family]:checked')?.focus();
  }, [open]);

  // TAB CYCLE over the TAB STOPS (the family list is a roving radiogroup), by document order, so focus never leaks
  // into the page behind a panel that announces itself as a dialog. No `aria-modal`: the page stays live by pointer.
  const onPanelKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const panel = panelRef.current;
    if (event.key !== 'Tab' || !panel) return;
    const stops = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(element => element.tabIndex >= 0);
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (!first || !last) return;
    const active = document.activeElement as HTMLElement | null;
    const follows = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    if (event.shiftKey) {
      if (!active || active === first || !follows(first, active)) {
        event.preventDefault();
        last.focus();
      }
      return;
    }
    if (!active || active === last || !follows(active, last)) {
      event.preventDefault();
      first.focus();
    }
  }, []);

  // The panel hangs from its trigger's right edge: slide it back inside a narrow viewport (a transform, no relayout).
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!open || panel === null) return;
    panel.style.transform = '';
    const { left, right } = panel.getBoundingClientRect();
    const edge = 8;
    const width = document.documentElement.clientWidth;
    const shift = left < edge ? edge - left : right > width - edge ? width - edge - right : 0;
    if (shift !== 0) panel.style.transform = `translateX(${Math.round(shift)}px)`;
  }, [open]);

  const activeFamily = families.find(option => option.id === family);
  const modeLabel = MODE_OPTIONS.find(option => option.id === mode)?.label ?? 'Auto';
  const summary = `Theme: ${activeFamily?.label ?? family}, ${modeLabel}${mode === 'system' ? ` (${resolved})` : ''}`;

  return (
    <div ref={rootRef} className="relative shrink-0">
      <Button
        ref={triggerRef}
        variant="ghost"
        size="sm"
        data-theme-trigger=""
        onClick={() => (open ? close(true) : setOpen(true))}
        title={summary}
        aria-label={summary}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
      >
        <Palette size={14} aria-hidden="true" />
      </Button>
      {open && (
        // The scrim: a press anywhere outside the panel closes it; inside `rootRef`, so the document handler leaves it.
        <div aria-hidden="true" className="fixed inset-0 z-40" data-theme-backdrop="" onClick={() => close(false)} />
      )}
      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label="Theme"
          onKeyDown={onPanelKeyDown}
          className="absolute right-0 top-full z-50 mt-1 w-[272px] rounded-panel border border-border bg-surface p-panel shadow-popover sm:w-[292px]"
        >
          <div className="mb-2 mt-0 flex items-center justify-between gap-2 text-meta">
            <span className="font-semibold text-fg">Theme</span>
            <span className="ml-auto text-faint" data-theme-scope="">
              This device
            </span>
            <button
              type="button"
              aria-label="Close theme picker"
              title="Close"
              data-theme-close=""
              onClick={() => close(true)}
              className="inline-grid h-8 w-8 shrink-0 place-items-center rounded-control text-muted hover:bg-surface-2 hover:text-fg"
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>
          <ThemeSettings theme={theme} listRef={listRef} />
          <Button
            variant="ghost"
            size="sm"
            className="mt-2 w-full justify-center"
            data-theme-done=""
            onClick={() => close(true)}
          >
            Done
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * The quick switch in a page's own top row, at the right end (today's `PageThemeSwitch`). A phone's bar carries the
 * theme in Settings, so there — and outside an app shell — this renders nothing. No page gets a bar just for it.
 */
export function PageThemeSwitch() {
  const theme = useDeviceTheme();
  const phone = useLayoutMode() === 'drawer';
  if (phone || theme === null) return null;
  return (
    <div data-page-theme-switch="" className="shrink-0">
      <ThemeToggle theme={theme} />
    </div>
  );
}
