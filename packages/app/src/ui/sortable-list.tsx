/**
 * A LIST YOU REORDER BY HAND, with no text box in sight (Settings › Layout used to ask people to type nav item names
 * separated by commas). Three equal ways to move a row, so nobody is left out:
 *
 *   - POINTER (mouse, touch, pen): press the grip and drag. Only the grip starts a drag, so the rest of the row stays
 *     scrollable and clickable on a phone, and a row's own controls (an eye toggle) still work.
 *   - KEYBOARD: focus the grip, Space lifts the row, ArrowUp/ArrowDown move it, Enter drops it, Escape puts it back.
 *   - BUTTONS: an Up and a Down button on every row, for a screen reader or a switch that never drags.
 *
 * The caller owns the order. The list shows the caller's `items`, keeps a private draft while a row is held, and calls
 * `onReorder` exactly once, on drop (or at once for an Up/Down button). A cancelled drag calls nothing.
 *
 * MOTION. Rows that make way slide to their new place (FLIP) and the held row lifts; both stop when
 * {@link useMotionAllowed} says the screen must be still, and the order still changes.
 */
import { ChevronDown, ChevronUp, GripVertical } from 'lucide-react';
import type { CSSProperties, KeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  cancelledMessage,
  dropIndex,
  droppedMessage,
  liftedMessage,
  movedMessage,
  moveItem,
  sameOrder,
} from './lib/sortable-order.ts';
import { useMotionAllowed } from './use-motion-allowed.ts';

export interface SortableRowState {
  /** Zero-based place in the order being shown (the draft, while a row is held). */
  readonly index: number;
  readonly count: number;
  readonly held: boolean;
}

export interface SortableListProps<T> {
  readonly items: readonly T[];
  /** A stable id per item: the row keeps its focus and its place across a reorder. */
  readonly itemKey: (item: T) => string;
  /** What a screen reader calls the item. */
  readonly itemLabel: (item: T) => string;
  readonly onReorder: (next: readonly T[]) => void;
  /** The row's content. It may hold interactive controls: only the grip drags. */
  readonly renderItem: (item: T, row: SortableRowState) => ReactNode;
  /** The list's accessible name. */
  readonly label: string;
  readonly className?: string;
  /** Rows stay visible, and nothing moves. */
  readonly disabled?: boolean;
}

interface Drag {
  readonly key: string;
  readonly pointerId: number;
  readonly startY: number;
  /** The row's middle, from the list's top, when the press began. */
  readonly startCentre: number;
}

/** What the drag reads on every move or release: the latest closure, so a listener added once never goes stale. */
interface PointerHandlers {
  readonly move: (event: PointerEvent) => void;
  readonly end: (event: PointerEvent) => void;
  readonly lost: (event: PointerEvent) => void;
}

const FLIP_MS = 150;
const centreOf = (row: HTMLElement): number => row.offsetTop + row.offsetHeight / 2;

export function SortableList<T>({
  items,
  itemKey,
  itemLabel,
  onReorder,
  renderItem,
  label,
  className,
  disabled = false,
}: SortableListProps<T>) {
  const motion = useMotionAllowed();
  const [draft, setDraft] = useState<readonly T[] | null>(null);
  const [heldKey, setHeldKey] = useState<string | null>(null);
  const [mode, setMode] = useState<'pointer' | 'keyboard' | null>(null);
  const [offset, setOffset] = useState(0);
  /** Where the pointer says the held row's middle is, from the list's top. The offset is measured from it. */
  const [dragCentre, setDragCentre] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const rows = useRef(new Map<string, HTMLLIElement>());
  const drag = useRef<Drag | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const handlers = useRef<PointerHandlers | null>(null);
  const untrack = useRef<(() => void) | null>(null);
  const tops = useRef(new Map<string, number>());
  const shown = draft ?? items;
  const keys = shown.map(itemKey);
  const count = shown.length;
  const labelOf = (key: string): string => {
    const item = shown.find(candidate => itemKey(candidate) === key);
    return item === undefined ? key : itemLabel(item);
  };

  // FLIP: a row that made way slides from where it was to where it is, unless the screen must be still.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the order is the trigger
  useLayoutEffect(() => {
    for (const [key, row] of rows.current) {
      const before = tops.current.get(key);
      const now = row.offsetTop;
      tops.current.set(key, now);
      if (!motion || before === undefined || before === now || key === heldKey) continue;
      row.style.transition = 'none';
      row.style.transform = `translateY(${before - now}px)`;
      void row.offsetHeight;
      row.style.transition = `transform ${FLIP_MS}ms ease`;
      row.style.transform = '';
    }
  }, [keys.join('\u0000'), motion, heldKey]);

  // THE HELD OFFSET, measured AFTER the order is drawn. The row's layout place changes when the order does, so an offset
  // worked out from the place it had before the move would shift it by the distance it just travelled.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the order is a trigger
  useLayoutEffect(() => {
    if (mode !== 'pointer' || heldKey === null || dragCentre === null) return;
    const row = rows.current.get(heldKey);
    if (row !== undefined) setOffset(dragCentre - centreOf(row));
  }, [dragCentre, heldKey, mode, keys.join('\u0000')]);

  const finish = useCallback((): void => {
    untrack.current?.();
    untrack.current = null;
    drag.current = null;
    setDraft(null);
    setHeldKey(null);
    setMode(null);
    setOffset(0);
    setDragCentre(null);
  }, []);

  // A drag is followed on the DOCUMENT and the list, never on the grip: React moves a row in the DOM when the order
  // changes, and a node that moves loses the pointer, so the release would never reach it. Neither the document nor
  // the list moves. The list also holds the capture, so a release outside the window is still delivered.
  const track = (pointerId: number): void => {
    untrack.current?.();
    const list = listRef.current;
    try {
      list?.setPointerCapture?.(pointerId);
    } catch {
      // The pointer is not active (a synthetic press): the document listeners below still follow it.
    }
    const onMove = (event: PointerEvent): void => handlers.current?.move(event);
    const onEnd = (event: PointerEvent): void => handlers.current?.end(event);
    const onLost = (event: PointerEvent): void => handlers.current?.lost(event);
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onEnd);
    document.addEventListener('pointercancel', onEnd);
    list?.addEventListener('lostpointercapture', onLost);
    untrack.current = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onEnd);
      document.removeEventListener('pointercancel', onEnd);
      list?.removeEventListener('lostpointercapture', onLost);
      try {
        if (list?.hasPointerCapture?.(pointerId)) list.releasePointerCapture(pointerId);
      } catch {
        // Already released with the pointer.
      }
    };
  };

  // Releasing the component mid-drag leaves nothing listening.
  useEffect(
    () => () => {
      untrack.current?.();
      untrack.current = null;
    },
    [],
  );

  const commit = (): void => {
    const next = draft ?? items;
    const changed = !sameOrder(next.map(itemKey), items.map(itemKey));
    const key = heldKey;
    finish();
    if (changed) onReorder(next);
    if (key !== null) setAnnouncement(droppedMessage(labelOf(key), next.map(itemKey).indexOf(key), next.length));
  };

  const cancel = (key: string): void => {
    const index = items.map(itemKey).indexOf(key);
    finish();
    setAnnouncement(cancelledMessage(labelOf(key), index, items.length));
  };
  const cancelNow = useRef(cancel);
  cancelNow.current = cancel;

  // Escape puts a held row back, whichever way it was picked up.
  useEffect(() => {
    if (heldKey === null) return;
    const key = heldKey;
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      cancelNow.current(key);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [heldKey]);

  const moveTo = (key: string, target: number, from: readonly T[]): readonly T[] => {
    const at = from.map(itemKey).indexOf(key);
    return moveItem(from, at, target);
  };

  const nudge = (key: string, by: -1 | 1): void => {
    const at = keys.indexOf(key);
    const target = at + by;
    if (target < 0 || target >= count) return;
    onReorder(moveItem(shown, at, target));
    setAnnouncement(movedMessage(labelOf(key), target, count));
  };

  const onGripPointerDown = (key: string, event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (disabled || heldKey !== null) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const row = rows.current.get(key);
    if (row === undefined) return;
    event.preventDefault();
    event.currentTarget.focus?.();
    drag.current = { key, pointerId: event.pointerId, startY: event.clientY, startCentre: centreOf(row) };
    track(event.pointerId);
    setDraft(items);
    setDragCentre(centreOf(row));
    setHeldKey(key);
    setMode('pointer');
    setAnnouncement(liftedMessage(labelOf(key), keys.indexOf(key), count));
  };

  const onPointerMove = (event: PointerEvent): void => {
    const current = drag.current;
    if (current === null || event.pointerId !== current.pointerId) return;
    const dragged = current.startCentre + (event.clientY - current.startY);
    const others = keys.filter(key => key !== current.key);
    const target = dropIndex(
      others.map(key => centreOf(rows.current.get(key) as HTMLLIElement)),
      dragged,
    );
    const next = moveTo(current.key, target, shown);
    if (next !== shown) {
      setDraft(next);
      setAnnouncement(movedMessage(labelOf(current.key), target, count));
    }
    setDragCentre(dragged);
  };

  const onPointerEnd = (event: PointerEvent): void => {
    const current = drag.current;
    if (current === null || event.pointerId !== current.pointerId) return;
    if (event.type === 'pointercancel') cancel(current.key);
    else commit();
  };

  // The capture went without a release (the browser took it): the drag is over, and nothing was dropped.
  const onPointerLost = (event: PointerEvent): void => {
    const current = drag.current;
    if (current === null || event.pointerId !== current.pointerId) return;
    cancel(current.key);
  };
  handlers.current = { move: onPointerMove, end: onPointerEnd, lost: onPointerLost };

  const onGripKeyDown = (key: string, event: KeyboardEvent<HTMLButtonElement>): void => {
    if (disabled || mode === 'pointer') return;
    const holding = heldKey === key;
    if (!holding) {
      if (event.key !== ' ' && event.key !== 'Enter') return;
      event.preventDefault();
      setDraft(items);
      setHeldKey(key);
      setMode('keyboard');
      setAnnouncement(liftedMessage(labelOf(key), keys.indexOf(key), count));
      return;
    }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      const target = keys.indexOf(key) + (event.key === 'ArrowUp' ? -1 : 1);
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
    <div className={className}>
      <ul aria-label={label} className="relative m-0 flex list-none flex-col gap-1.5 p-0" ref={listRef}>
        {shown.map((item, index) => {
          const key = itemKey(item);
          const held = key === heldKey;
          const name = itemLabel(item);
          const style: CSSProperties = held
            ? {
                transform: mode === 'pointer' ? `translateY(${offset}px)` : undefined,
                zIndex: 1,
                touchAction: 'none',
              }
            : {};
          return (
            <li
              className={`flex items-center gap-1 rounded-lg border bg-surface px-1 ${
                held ? 'border-accent shadow-lg' : 'border-border-soft'
              }`}
              data-sortable-key={key}
              data-state={held ? 'held' : 'idle'}
              key={key}
              ref={element => {
                if (element) rows.current.set(key, element);
                else rows.current.delete(key);
              }}
              style={style}
            >
              <button
                aria-label={`Reorder ${name}`}
                aria-pressed={held && mode === 'keyboard'}
                className="inline-flex h-11 w-9 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-accent aria-disabled:cursor-not-allowed aria-disabled:opacity-40"
                aria-disabled={disabled ? true : undefined}
                data-sortable-grip=""
                onBlur={() => {
                  if (held && mode === 'keyboard') cancel(key);
                }}
                onKeyDown={event => onGripKeyDown(key, event)}
                onPointerDown={event => onGripPointerDown(key, event)}
                type="button"
              >
                <GripVertical aria-hidden="true" size={16} />
              </button>
              <div className="min-w-0 flex-1">{renderItem(item, { index, count, held })}</div>
              <button
                aria-disabled={disabled || index === 0 ? true : undefined}
                aria-label={`Move ${name} up`}
                className="inline-flex h-11 w-9 shrink-0 items-center justify-center rounded-md text-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-accent aria-disabled:cursor-not-allowed aria-disabled:opacity-40"
                onClick={() => {
                  if (!disabled) nudge(key, -1);
                }}
                type="button"
              >
                <ChevronUp aria-hidden="true" size={16} />
              </button>
              <button
                aria-disabled={disabled || index === count - 1 ? true : undefined}
                aria-label={`Move ${name} down`}
                className="inline-flex h-11 w-9 shrink-0 items-center justify-center rounded-md text-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-accent aria-disabled:cursor-not-allowed aria-disabled:opacity-40"
                onClick={() => {
                  if (!disabled) nudge(key, 1);
                }}
                type="button"
              >
                <ChevronDown aria-hidden="true" size={16} />
              </button>
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
