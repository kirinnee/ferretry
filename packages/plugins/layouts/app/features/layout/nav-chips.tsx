/**
 * THE NAVIGATION ITEMS AS CHIPS you reorder and hide (Settings › Layout): a compact grid, one chip per place — its icon,
 * its name, an eye — instead of a full-width row each. Three equal ways to move one, so nobody is left out:
 *
 *   - POINTER: press a chip anywhere (a mouse or pen) and drag; the whole chip is the handle, so there is no grip to
 *     aim at. A finger starts a drag from the chip's icon only, so the rest of the chip still scrolls the page.
 *   - KEYBOARD: focus the chip, Space lifts it, the arrow keys move it, Enter drops it, Escape puts it back.
 *   - BUTTONS: Earlier and Later on every chip, for a screen reader or a switch that never drags.
 *
 * The caller owns the order: it is shown from `rows`, a private draft holds it while a chip is held, and `onReorder`
 * is called exactly once, on drop (at once for an Earlier / Later button). A cancelled drag calls nothing. The chip
 * that makes way slides to its new place (FLIP) and the held chip lifts; both stop when the screen must be still.
 */
import { NavIcon } from '@ferretry/app';
import {
  cancelledMessage,
  droppedMessage,
  liftedMessage,
  movedMessage,
  moveItem,
  sameOrder,
  useMotionAllowed,
} from '@ferretry/app/ui';
import {
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { type Centre, chipDropIndex } from '../../lib/chip-order.ts';
import type { Place } from '../../lib/list-places.ts';
import { EyeIcon } from './eye-icon.tsx';
import './nav-chips.css';

export interface NavChipsProps {
  readonly rows: readonly Place[];
  /** The list's accessible name. */
  readonly label: string;
  /** Chips stay visible and nothing moves. */
  readonly disabled?: boolean;
  readonly onReorder: (next: readonly Place[]) => void;
  readonly onToggle: (id: string, hidden: boolean) => void;
}

interface Drag {
  readonly key: string;
  readonly pointerId: number;
  /** Where inside the chip the pointer took hold. */
  readonly grab: Centre;
}

const FLIP_MS = 150;

const Chevron = ({ turn }: { readonly turn: 'left' | 'right' }) => (
  <svg
    aria-hidden="true"
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.25"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d={turn === 'left' ? 'M15 5l-7 7 7 7' : 'M9 5l7 7-7 7'} />
  </svg>
);

/** The handle a chip shows when its place has no icon of its own (the top bar, the side panels). */
const GripDots = () => (
  <svg aria-hidden="true" width="12" height="16" viewBox="0 0 12 16" fill="currentColor">
    {[3, 8, 13].flatMap(y => [3, 9].map(x => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.3" />))}
  </svg>
);

export function NavChips({ rows, label, disabled = false, onReorder, onToggle }: NavChipsProps) {
  const motion = useMotionAllowed();
  const [draft, setDraft] = useState<readonly Place[] | null>(null);
  const [heldKey, setHeldKey] = useState<string | null>(null);
  const [mode, setMode] = useState<'pointer' | 'keyboard' | null>(null);
  /** Where the pointer is, in the grid's own coordinates. */
  const [pointer, setPointer] = useState<Centre | null>(null);
  const [offset, setOffset] = useState<Centre>({ x: 0, y: 0 });
  const [announcement, setAnnouncement] = useState('');
  const chips = useRef(new Map<string, HTMLLIElement>());
  const drag = useRef<Drag | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const spots = useRef(new Map<string, Centre>());
  const shown = draft ?? rows;
  const keys = shown.map(row => row.id);
  const count = shown.length;
  const labelOf = (key: string): string => shown.find(row => row.id === key)?.label ?? key;

  // FLIP: a chip that made way slides from where it was to where it is, unless the screen must be still.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the order is the trigger
  useLayoutEffect(() => {
    for (const [key, chip] of chips.current) {
      const before = spots.current.get(key);
      const now = { x: chip.offsetLeft, y: chip.offsetTop };
      spots.current.set(key, now);
      if (!motion || before === undefined || key === heldKey) continue;
      if (before.x === now.x && before.y === now.y) continue;
      chip.style.transition = 'none';
      chip.style.transform = `translate(${before.x - now.x}px, ${before.y - now.y}px)`;
      void chip.offsetHeight;
      chip.style.transition = `transform ${FLIP_MS}ms ease`;
      chip.style.transform = '';
    }
  }, [keys.join('\u0000'), motion, heldKey]);

  // The held chip's offset is measured AFTER the order is drawn: its place in the grid changes with the order, so an
  // offset worked out from the place it had before the move would shift it by the distance it just travelled.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the order is a trigger
  useLayoutEffect(() => {
    const current = drag.current;
    if (mode !== 'pointer' || heldKey === null || pointer === null || current === null) return;
    const chip = chips.current.get(heldKey);
    if (chip !== undefined)
      setOffset({ x: pointer.x - current.grab.x - chip.offsetLeft, y: pointer.y - current.grab.y - chip.offsetTop });
  }, [pointer, heldKey, mode, keys.join('\u0000')]);

  const finish = (): void => {
    drag.current = null;
    setDraft(null);
    setHeldKey(null);
    setMode(null);
    setPointer(null);
    setOffset({ x: 0, y: 0 });
  };

  const commit = (): void => {
    const next = draft ?? rows;
    const changed = !sameOrder(
      next.map(row => row.id),
      rows.map(row => row.id),
    );
    const key = heldKey;
    finish();
    if (changed) onReorder(next);
    if (key !== null)
      setAnnouncement(
        droppedMessage(
          labelOf(key),
          next.findIndex(row => row.id === key),
          next.length,
        ),
      );
  };

  const cancel = (key: string): void => {
    const index = rows.findIndex(row => row.id === key);
    finish();
    setAnnouncement(cancelledMessage(labelOf(key), index, rows.length));
  };
  const latest = useRef({ commit, cancel });
  latest.current = { commit, cancel };

  const moveTo = (key: string, target: number, from: readonly Place[]): readonly Place[] =>
    moveItem(
      from,
      from.findIndex(row => row.id === key),
      target,
    );

  const nudge = (key: string, by: -1 | 1): void => {
    const at = keys.indexOf(key);
    const target = at + by;
    if (target < 0 || target >= count) return;
    onReorder(moveItem(shown, at, target));
    setAnnouncement(movedMessage(labelOf(key), target, count));
  };

  const listPoint = (event: { readonly clientX: number; readonly clientY: number }): Centre => {
    const box = listRef.current?.getBoundingClientRect();
    return { x: event.clientX - (box?.left ?? 0), y: event.clientY - (box?.top ?? 0) };
  };

  const onPointerMove = (event: PointerEvent): void => {
    const current = drag.current;
    if (current === null || event.pointerId !== current.pointerId) return;
    const at = listPoint(event);
    const held = chips.current.get(current.key);
    if (held === undefined) return;
    const dragged = {
      x: at.x - current.grab.x + held.offsetWidth / 2,
      y: at.y - current.grab.y + held.offsetHeight / 2,
    };
    const others = keys.filter(key => key !== current.key);
    const centres = others.map(key => {
      const chip = chips.current.get(key) as HTMLLIElement;
      return { x: chip.offsetLeft + chip.offsetWidth / 2, y: chip.offsetTop + chip.offsetHeight / 2 };
    });
    const target = chipDropIndex(centres, dragged, held.offsetHeight);
    const next = moveTo(current.key, target, shown);
    if (next !== shown) {
      setDraft(next);
      setAnnouncement(movedMessage(labelOf(current.key), target, count));
    }
    setPointer(at);
  };
  const onPointerEnd = (event: PointerEvent): void => {
    const current = drag.current;
    if (current === null || event.pointerId !== current.pointerId) return;
    if (event.type === 'pointercancel') latest.current.cancel(current.key);
    else latest.current.commit();
  };
  const handlers = useRef({ move: onPointerMove, end: onPointerEnd });
  handlers.current = { move: onPointerMove, end: onPointerEnd };

  // A drag is followed on the DOCUMENT, never on the chip: React moves a chip in the DOM when the order changes, and a
  // node that moves loses the pointer, so the release would never reach it.
  useEffect(() => {
    if (mode !== 'pointer') return;
    const move = (event: PointerEvent): void => handlers.current.move(event);
    const end = (event: PointerEvent): void => handlers.current.end(event);
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', end);
    document.addEventListener('pointercancel', end);
    return () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', end);
      document.removeEventListener('pointercancel', end);
    };
  }, [mode]);

  // Escape puts a held chip back, whichever way it was picked up.
  useEffect(() => {
    if (heldKey === null) return;
    const key = heldKey;
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      latest.current.cancel(key);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [heldKey]);

  const onChipPointerDown = (key: string, event: ReactPointerEvent<HTMLLIElement>): void => {
    if (disabled || heldKey !== null) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const target = event.target as HTMLElement;
    // A chip's own buttons keep their own clicks; a finger drags from the icon only, so the page still scrolls.
    if (target.closest('[data-chip-action]') !== null) return;
    if (event.pointerType === 'touch' && target.closest('[data-chip-handle]') === null) return;
    const chip = chips.current.get(key);
    if (chip === undefined) return;
    const at = listPoint(event);
    event.preventDefault();
    drag.current = {
      key,
      pointerId: event.pointerId,
      grab: { x: at.x - chip.offsetLeft, y: at.y - chip.offsetTop },
    };
    setDraft(rows);
    setPointer(at);
    setHeldKey(key);
    setMode('pointer');
    setAnnouncement(liftedMessage(labelOf(key), keys.indexOf(key), count));
  };

  const onKeyDown = (key: string, event: KeyboardEvent<HTMLButtonElement>): void => {
    if (disabled || mode === 'pointer') return;
    if (heldKey !== key) {
      if (event.key !== ' ' && event.key !== 'Enter') return;
      event.preventDefault();
      setDraft(rows);
      setHeldKey(key);
      setMode('keyboard');
      setAnnouncement(liftedMessage(labelOf(key), keys.indexOf(key), count));
      return;
    }
    const earlier = event.key === 'ArrowUp' || event.key === 'ArrowLeft';
    if (earlier || event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      event.preventDefault();
      const target = keys.indexOf(key) + (earlier ? -1 : 1);
      const next = moveTo(key, target, shown);
      if (next === shown) return;
      setDraft(next);
      setAnnouncement(movedMessage(labelOf(key), Math.max(0, Math.min(count - 1, target)), count));
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      commit();
    }
  };

  return (
    <div className="min-w-0" data-nav-chips="">
      <ul aria-label={label} className="fy-chips" ref={listRef}>
        {shown.map((row, index) => {
          const held = row.id === heldKey;
          return (
            <li
              key={row.id}
              className="fy-chip"
              data-chip-key={row.id}
              data-state={held ? 'held' : 'idle'}
              data-hidden={row.hidden ? '' : undefined}
              data-sortable-key={row.id}
              ref={element => {
                if (element) chips.current.set(row.id, element);
                else chips.current.delete(row.id);
              }}
              style={
                held && mode === 'pointer'
                  ? { transform: `translate(${offset.x}px, ${offset.y}px)`, zIndex: 2 }
                  : undefined
              }
              onPointerDown={event => onChipPointerDown(row.id, event)}
            >
              <button
                type="button"
                data-chip-main=""
                data-sortable-grip=""
                aria-label={`Reorder ${row.label}`}
                aria-pressed={held && mode === 'keyboard'}
                aria-disabled={disabled ? true : undefined}
                className="fy-chip-main"
                onKeyDown={event => onKeyDown(row.id, event)}
                onBlur={() => {
                  if (held && mode === 'keyboard') cancel(row.id);
                }}
              >
                <span className="fy-chip-icon" data-chip-handle="">
                  {row.icon === undefined ? <GripDots /> : <NavIcon name={row.icon} />}
                </span>
                <span className="fy-chip-name">{row.label}</span>
              </button>
              <button
                type="button"
                data-chip-action=""
                aria-label={`Move ${row.label} earlier`}
                aria-disabled={disabled || index === 0 ? true : undefined}
                className="fy-chip-act"
                onClick={() => {
                  if (!disabled) nudge(row.id, -1);
                }}
              >
                <Chevron turn="left" />
              </button>
              <button
                type="button"
                data-chip-action=""
                aria-label={`Move ${row.label} later`}
                aria-disabled={disabled || index === count - 1 ? true : undefined}
                className="fy-chip-act"
                onClick={() => {
                  if (!disabled) nudge(row.id, 1);
                }}
              >
                <Chevron turn="right" />
              </button>
              {row.locked ? null : (
                <button
                  type="button"
                  data-chip-action=""
                  aria-pressed={!row.hidden}
                  aria-label={`${row.hidden ? 'Show' : 'Hide'} ${row.label}`}
                  title={row.hidden ? 'Hidden: press to show' : 'Shown: press to hide'}
                  aria-disabled={disabled ? true : undefined}
                  className="fy-chip-act"
                  onClick={() => {
                    if (!disabled) onToggle(row.id, !row.hidden);
                  }}
                >
                  <EyeIcon hidden={row.hidden} />
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <div aria-live="polite" className="sr-only" role="status">
        {announcement}
      </div>
    </div>
  );
}
