/**
 * THE PHONE'S ONE-ROW FILTERS: a status menu ("Open ▾": Open / Snoozed 18 / Replied / Resolved), a who menu
 * ("All ▾": All / Interactive / Agents) and Find behind a search icon. The counts live inside the menus, so the row
 * stays one line wide. Each menu is a button that opens a radio list: Esc and a click outside close it, ↑ ↓ walk it.
 */

import { ChevronDown, Search, X } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';

interface FilterChoice<T extends string> {
  readonly value: T;
  /** The words on the button when chosen, and on its line in the menu. */
  readonly label: string;
}

interface FilterMenuProps<T extends string> {
  /** What the group is called to a screen reader: "Show", "Ferrets". */
  readonly name: string;
  readonly value: T;
  readonly choices: readonly FilterChoice<T>[];
  readonly onChange: (next: T) => void;
  /** The data attribute each choice carries, so a test or a harness finds it by value. */
  readonly choiceHook: 'data-agenda-filter-option' | 'data-agenda-kind-option';
  readonly hook: 'data-agenda-filter' | 'data-agenda-kind';
  readonly icon?: ReactNode;
}

const itemsOf = (root: HTMLElement | null): HTMLElement[] =>
  root === null ? [] : [...root.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];

export function FilterMenu<T extends string>({
  name,
  value,
  choices,
  onChange,
  choiceHook,
  hook,
  icon,
}: FilterMenuProps<T>) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const list = useRef<HTMLDivElement | null>(null);
  const menuId = useId();
  const current = choices.find(choice => choice.value === value) ?? choices[0];

  useEffect(() => {
    if (!open) return;
    (
      itemsOf(list.current).find(item => item.getAttribute('aria-checked') === 'true') ?? itemsOf(list.current)[0]
    )?.focus();
    const onPointer = (event: PointerEvent): void => {
      if (event.target instanceof Node && root.current?.contains(event.target) !== true) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [open]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const items = itemsOf(list.current);
    const at = items.findIndex(item => item === document.activeElement);
    event.preventDefault();
    const step = event.key === 'ArrowDown' ? 1 : -1;
    items[(at + step + items.length) % items.length]?.focus();
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the keys belong to the menu this wrapper holds
    <div className="fy-filter-menu" onKeyDown={onKeyDown} ref={root} {...{ [hook]: '' }}>
      <button
        aria-controls={open ? menuId : undefined}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`${name}: ${current?.label ?? ''}`}
        className="fy-filter-menu__trigger"
        onClick={() => setOpen(was => !was)}
        ref={trigger}
        type="button"
      >
        {icon}
        {current?.label}
        <ChevronDown aria-hidden="true" size={14} />
      </button>
      {open ? (
        <div aria-label={name} className="fy-filter-menu__list" id={menuId} ref={list} role="menu">
          {choices.map(choice => (
            <button
              aria-checked={choice.value === value}
              className="fy-filter-menu__item"
              key={choice.value}
              onClick={() => {
                setOpen(false);
                trigger.current?.focus();
                onChange(choice.value);
              }}
              role="menuitemradio"
              type="button"
              {...{ [choiceHook]: choice.value }}
            >
              {choice.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** The header's Find box. */
export function FindBox({
  query,
  onChange,
  focus = false,
}: {
  readonly query: string;
  readonly onChange: (next: string) => void;
  /** Take the keyboard as it appears (the phone's search icon opened it). */
  readonly focus?: boolean;
}) {
  const input = useRef<HTMLInputElement | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: focus once, as the box appears
  useEffect(() => {
    if (focus) input.current?.focus();
  }, []);
  return (
    <label className="fy-attn-inbox__find">
      <Search aria-hidden="true" size={14} />
      <input
        aria-label="Find in Inbox"
        className="fy-attn-inbox__find-input"
        data-agenda-find=""
        onChange={event => onChange(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Escape' && query !== '') {
            event.preventDefault();
            onChange('');
          }
        }}
        placeholder="Find"
        ref={input}
        type="search"
        value={query}
      />
    </label>
  );
}

/** Find behind a search icon: the icon opens the box in the row; closing it clears what was typed. */
export function FindToggle({ query, onChange }: { readonly query: string; readonly onChange: (next: string) => void }) {
  const [open, setOpen] = useState(false);
  if (!open && query === '') {
    return (
      <button
        aria-label="Find"
        className="fy-filter-menu__find"
        data-agenda-find-open=""
        onClick={() => setOpen(true)}
        type="button"
      >
        <Search aria-hidden="true" size={18} />
      </button>
    );
  }
  return (
    <span className="fy-filter-menu__finding">
      <FindBox focus={open} onChange={onChange} query={query} />
      <button
        aria-label="Close Find"
        className="fy-filter-menu__find"
        data-agenda-find-close=""
        onClick={() => {
          onChange('');
          setOpen(false);
        }}
        type="button"
      >
        <X aria-hidden="true" size={18} />
      </button>
    </span>
  );
}
