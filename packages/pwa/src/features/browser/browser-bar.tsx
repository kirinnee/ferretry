/**
 * THE BROWSER BAR — the ONE row above a browser page.
 *
 * It replaces five stacked rows (a page strip, a toolbar, a status row, a controls row and a banner).
 * Left to right: the page's name (it opens the session's pages), the address, ONE state chip, back /
 * forward / reload and a ⋯ menu that holds everything rarer. The address truncates and says the whole
 * thing on hover; nothing in the bar wraps or scrolls sideways, on a phone or a desktop.
 *
 * The chip is the bar's one way to tell a person something. A notice that matters — the owner has
 * taken the page, an agent hands it over, a human check, a failure — keeps its colour and sits IN THE
 * BAR, never in the menu; tapping the chip opens its detail and the action that answers it.
 *
 * Presentational: every fact and every intent comes from the host (`UnifiedBrowserSurface`).
 */

import { ChevronDown, Globe2, MoreVertical, Search } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';

import { Button } from '../../shell/primitives.tsx';
import { compactAddress, type BrowserChip } from './browser-bar-model.ts';

type Open = 'chip' | 'pages' | 'menu' | null;

export interface BrowserBarStep {
  readonly label: string;
  readonly disabled: boolean;
  readonly onClick: () => void;
  readonly icon: ReactNode;
}

export interface BrowserBarProps {
  /** The page's name — what a `%browser:` reference calls it. */
  readonly name: string;
  readonly address: string;
  readonly onAddressChange: (address: string) => void;
  readonly onAddressFocus: () => void;
  readonly onAddressBlur: () => void;
  readonly onNavigate: () => void;
  readonly navigateDisabled: boolean;
  readonly chip: BrowserChip;
  /** The chip's detail: what it means and the actions that answer it. */
  readonly chipDetail: ReactNode;
  readonly back: BrowserBarStep;
  readonly forward: BrowserBarStep;
  readonly reload: BrowserBarStep;
  /** The ⋯ menu. */
  readonly menu: ReactNode;
  /** The session's pages. Absent: the name is a plain label. */
  readonly pages?: ReactNode;
  /** The (debounced) busy flag: only the line's opacity follows it, so the bar never changes height. */
  readonly working: boolean;
  readonly menuTitle: string;
  /** Closes every popover when it changes (the host re-scoped). */
  readonly resetKey: string;
}

const popoverClass =
  'absolute top-full z-50 mt-1 overflow-y-auto rounded-panel border border-border bg-surface p-2 shadow-popover';

export function BrowserBar({
  name,
  address,
  onAddressChange,
  onAddressFocus,
  onAddressBlur,
  onNavigate,
  navigateDisabled,
  chip,
  chipDetail,
  back,
  forward,
  reload,
  menu,
  pages,
  working,
  menuTitle,
  resetKey,
}: BrowserBarProps) {
  const [open, setOpen] = useState<Open>(null);
  const [editing, setEditing] = useState(false);
  const barRef = useRef<HTMLElement | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `resetKey` is the trigger — the host re-scoped, so every popover closes
  useEffect(() => {
    setOpen(null);
  }, [resetKey]);

  // Outside pointer or Escape closes whichever popover is open and gives focus back to the bar.
  useEffect(() => {
    if (open === null) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !barRef.current?.contains(event.target)) setOpen(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      const trigger = barRef.current?.querySelector<HTMLElement>(`[data-browser-trigger="${open}"]`);
      setOpen(null);
      window.requestAnimationFrame(() => trigger?.focus());
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const toggle = (next: Exclude<Open, null>) => setOpen(current => (current === next ? null : next));
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    onNavigate();
  };
  const stepClass = 'min-h-[44px] min-w-[36px] shrink-0 justify-center p-0 sm:min-w-[44px]';
  const stepFor = (part: 'back' | 'forward' | 'reload') =>
    part === 'forward' ? `${stepClass} max-sm:hidden` : stepClass;
  const step = (part: 'back' | 'forward' | 'reload', control: BrowserBarStep) => (
    <Button
      type="button"
      variant="ghost"
      disabled={control.disabled}
      onClick={control.onClick}
      className={stepFor(part)}
      aria-label={control.label}
      title={control.label.replace(/ in .*$/, '')}
      data-browser-bar-part={part}
    >
      {control.icon}
    </Button>
  );

  return (
    <header
      ref={barRef}
      className="relative flex min-h-[52px] shrink-0 items-center gap-1 border-b border-border-soft px-1.5 py-1"
      data-browser-bar=""
    >
      {pages === undefined ? null : (
        <button
          type="button"
          onClick={() => toggle('pages')}
          aria-haspopup="dialog"
          aria-expanded={open === 'pages'}
          aria-label={`Browser pages — ${name}`}
          title={`${name} — switch page`}
          data-browser-trigger="pages"
          data-browser-bar-part="page"
          className="inline-flex min-h-[44px] max-w-[4rem] shrink-0 items-center gap-0.5 rounded-control px-1 min-[420px]:max-w-[5.5rem] min-[420px]:px-1.5 text-ui font-medium text-fg hover:bg-accent-soft sm:max-w-[9rem]"
        >
          <Globe2 size={14} aria-hidden="true" className="shrink-0 text-muted" />
          <span className="hidden min-w-0 truncate min-[420px]:inline">{name}</span>
          <ChevronDown size={12} aria-hidden="true" className="shrink-0 text-muted" />
        </button>
      )}

      <form onSubmit={submit} className="flex min-w-0 flex-1" data-browser-bar-part="address">
        <label className="flex min-h-[40px] min-w-0 flex-1 items-center gap-1 rounded-control border border-strong bg-surface-2 px-2">
          <span className="sr-only">URL or DuckDuckGo search</span>
          <Search size={13} aria-hidden="true" className="hidden shrink-0 text-muted sm:block" />
          <input
            value={editing ? address : compactAddress(address)}
            onChange={event => onAddressChange(event.target.value)}
            onFocus={() => {
              setEditing(true);
              onAddressFocus();
            }}
            onBlur={() => {
              setEditing(false);
              onAddressBlur();
            }}
            placeholder="URL or search"
            title={address}
            inputMode="url"
            enterKeyHint="go"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className="h-9 w-0 min-w-0 flex-1 truncate border-0 bg-transparent p-0 shadow-none outline-none font-mono text-meta text-fg placeholder:text-muted"
          />
        </label>
        {/* Enter is Go: a visible button would take 44px from the address for a thing the keyboard does. */}
        <button type="submit" disabled={navigateDisabled} className="sr-only">
          Go
        </button>
      </form>

      <span className="shrink-0" data-browser-bar-part="chip">
        <button
          type="button"
          onClick={() => toggle('chip')}
          aria-haspopup="dialog"
          aria-expanded={open === 'chip'}
          aria-label={`Status: ${chip.summary}`}
          title={chip.summary}
          data-browser-chip={chip.kind}
          data-browser-trigger="chip"
          data-attention={chip.attention ? '' : undefined}
          data-tone={chip.tone}
          className="kt-badge inline-flex min-h-[32px] items-center gap-1 px-1.5 sm:max-w-[10rem]"
        >
          <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-current" />
          <span className="min-w-0 truncate">{chip.label}</span>
        </button>
        {open === 'chip' && (
          <div
            role="dialog"
            aria-label="Browser status"
            data-browser-chip-detail=""
            className={`${popoverClass} right-1.5 w-[min(320px,calc(100vw-16px))]`}
            style={{ maxHeight: 'min(70dvh, 420px)' }}
          >
            {chipDetail}
          </div>
        )}
      </span>

      {step('back', back)}
      {step('forward', forward)}
      {step('reload', reload)}

      <span className="flex shrink-0 items-center" data-browser-bar-part="menu">
        <Button
          type="button"
          variant="ghost"
          onClick={() => toggle('menu')}
          aria-haspopup="dialog"
          aria-expanded={open === 'menu'}
          aria-label="Browser controls"
          title={menuTitle}
          data-browser-trigger="menu"
          className="min-h-[44px] min-w-[36px] justify-center p-0 sm:min-w-[44px]"
        >
          <MoreVertical size={16} aria-hidden="true" />
        </Button>
        {open === 'menu' && (
          // biome-ignore lint/a11y/useKeyWithClickEvents: a keyboard press on a menu button is a click that bubbles here; this only closes the menu
          <div
            role="dialog"
            aria-label="Browser controls"
            data-browser-menu=""
            className={`${popoverClass} right-1.5 w-[min(300px,calc(100vw-16px))]`}
            style={{ maxHeight: 'min(calc(100dvh - 72px), 640px)' }}
            onClick={event => {
              if (event.target instanceof Element && event.target.closest('button,a') !== null) setOpen(null);
            }}
          >
            {menu}
          </div>
        )}
      </span>

      {open === 'pages' && pages !== undefined && (
        <div
          role="dialog"
          aria-label="Browser pages"
          className={`${popoverClass} left-1.5 w-[min(340px,calc(100vw-16px))]`}
          style={{ maxHeight: 'min(calc(100dvh - 72px), 640px)' }}
        >
          {pages}
        </div>
      )}

      {/* Mounted always, never on and off: only its opacity follows the work, so the bar never moves. */}
      <div
        className={`pointer-events-none absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-accent transition-opacity ${working ? 'opacity-100' : 'opacity-0'}`}
        role="status"
        aria-live="polite"
        data-browser-progress=""
      >
        <span className="sr-only">{working ? chip.summary : ''}</span>
      </div>
    </header>
  );
}
