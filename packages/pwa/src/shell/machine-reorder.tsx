/**
 * REORDERING THE MACHINES IN THE SESSIONS BAR — one gesture controller, three ways in.
 *
 *   POINTER   press the grip on a machine heading and move: a mouse drags at once past a few pixels, a
 *             finger must rest ~350ms first (a swipe sooner is a scroll). A line shows where it lands
 *             and the list scrolls when the pointer nears its edge. Nothing moves until the drop.
 *   KEYBOARD  focus the grip, Space picks up, ↑/↓ move, Space drops, Escape cancels. Each step is spoken.
 *   MENU      the heading's "⋯" menu: Move up / Move down.
 *
 * The grip is the ONLY place a drag can start, so a press on a session row stays the row's own (its
 * long-press menu, its link). A click on the grip does nothing: a drag needs movement.
 */

import { Ellipsis, GripVertical } from 'lucide-react';
import { type KeyboardEvent, type PointerEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useInputModality } from '../hooks/use-input-modality.ts';
import type { DaemonId } from '../lib/daemon-connection.ts';
import type { DropEdge } from '../lib/machine-order.ts';
import { ContextMenu, type ContextMenuItem } from './context-menu.tsx';
import {
  autoScrollDelta,
  cancelledMessage,
  type DropTarget,
  droppedMessage,
  dropTarget,
  LIFT_MS,
  type MachineBox,
  movedMessage,
  pickedUpMessage,
  SLOP_PX,
  shifted,
} from './machine-reorder-model.ts';

export type MoveMachine = (id: DaemonId, target: DaemonId, edge: DropEdge) => void;

export interface MachineReorder {
  /** The machines in the order to DRAW them: the keyboard's preview while one is picked up, else `ids`. */
  readonly drawn: readonly DaemonId[];
  readonly dragging: DaemonId | null;
  /** Where a pointer drag would land. */
  readonly over: DropTarget | null;
  /** What the live region says. */
  readonly announcement: string;
  readonly gripProps: (id: DaemonId, name: string) => GripProps;
  readonly menuItems: (id: DaemonId, name: string) => readonly ContextMenuItem[];
}

interface GripProps {
  readonly 'aria-label': string;
  readonly 'aria-pressed': boolean;
  readonly onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  readonly onBlur: () => void;
  readonly onClick: (event: { preventDefault: () => void; stopPropagation: () => void }) => void;
}

interface Press {
  readonly id: DaemonId;
  readonly x: number;
  readonly y: number;
  readonly touch: boolean;
  readonly grip: HTMLElement;
}

const boxesOf = (list: Element): readonly MachineBox[] =>
  [...list.querySelectorAll<HTMLElement>('[data-sbar-machine-group]')].map(element => {
    const { top, bottom } = element.getBoundingClientRect();
    return { id: element.dataset.sbarMachineGroup as DaemonId, top, bottom };
  });

export function useMachineReorder(
  ids: readonly DaemonId[],
  names: ReadonlyMap<DaemonId, string>,
  onMove: MoveMachine,
): MachineReorder {
  const [dragging, setDragging] = useState<DaemonId | null>(null);
  const [over, setOver] = useState<DropTarget | null>(null);
  const [preview, setPreview] = useState<{ readonly id: DaemonId; readonly order: readonly DaemonId[] } | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const latest = useRef({ ids, names, onMove, preview });
  latest.current = { ids, names, onMove, preview };
  const lift = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stop = useRef<(() => void) | null>(null);

  useEffect(() => () => stop.current?.(), []);

  // Moving a focused element in the DOM drops its focus; the keyboard's grip must keep it.
  useLayoutEffect(() => {
    if (preview === null) return;
    for (const grip of document.querySelectorAll<HTMLElement>('[data-machine-grip]'))
      if (grip.dataset.machineGrip === preview.id) grip.focus();
  }, [preview]);

  const nameOf = (id: DaemonId): string => latest.current.names.get(id) ?? String(id);
  const say = (
    message: (name: string, index: number, count: number) => string,
    id: DaemonId,
    order: readonly DaemonId[],
  ) => setAnnouncement(message(nameOf(id), order.indexOf(id), order.length));

  const startPointer = (press: Press) => {
    const list = press.grip.closest('.fy-sbar__list');
    let y = press.y;
    let began = false;
    let frame = 0;
    const clear = () => {
      if (lift.current !== null) clearTimeout(lift.current);
      lift.current = null;
      cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key, true);
      stop.current = null;
      setDragging(null);
      setOver(null);
    };
    const aim = () => {
      if (list === null) return null;
      const target = dropTarget(boxesOf(list), press.id, y);
      setOver(previous => (previous?.id === target?.id && previous?.edge === target?.edge ? previous : target));
      return target;
    };
    const begin = () => {
      began = true;
      setDragging(press.id);
      aim();
      const tick = () => {
        if (list !== null) {
          const { top, bottom } = list.getBoundingClientRect();
          const delta = autoScrollDelta(y, top, bottom);
          if (delta !== 0) {
            list.scrollTop += delta;
            aim();
          }
        }
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    };
    function move(event: globalThis.PointerEvent) {
      y = event.clientY;
      if (!began) {
        if (Math.hypot(event.clientX - press.x, event.clientY - press.y) <= SLOP_PX) return;
        if (press.touch) return clear();
        begin();
      }
      aim();
    }
    function up() {
      const target = began ? aim() : null;
      clear();
      if (target !== null) latest.current.onMove(press.id, target.id, target.edge);
    }
    function cancel() {
      clear();
    }
    function key(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') clear();
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key, true);
    stop.current = clear;
    if (press.touch) lift.current = setTimeout(begin, LIFT_MS);
  };

  const drop = (id: DaemonId, order: readonly DaemonId[]) => {
    setPreview(null);
    const at = order.indexOf(id);
    const before = order[at - 1];
    const after = order[at + 1];
    const unchanged = order.every((candidate, index) => candidate === latest.current.ids[index]);
    if (!unchanged && before !== undefined) latest.current.onMove(id, before, 'after');
    else if (!unchanged && after !== undefined) latest.current.onMove(id, after, 'before');
    say(droppedMessage, id, order);
  };

  const gripProps = (id: DaemonId, name: string): GripProps => ({
    'aria-label': `Reorder ${name}`,
    'aria-pressed': preview?.id === id,
    onPointerDown: event => {
      if (event.button !== 0) return;
      event.stopPropagation();
      stop.current?.();
      startPointer({
        id,
        x: event.clientX,
        y: event.clientY,
        touch: event.pointerType === 'touch',
        grip: event.currentTarget,
      });
    },
    onKeyDown: event => {
      const held = latest.current.preview;
      if (held === null || held.id !== id) {
        if (event.key !== ' ') return;
        event.preventDefault();
        setPreview({ id, order: latest.current.ids });
        say(pickedUpMessage, id, latest.current.ids);
        return;
      }
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault();
        const order = shifted(held.order, id, event.key === 'ArrowUp' ? -1 : 1);
        if (order !== held.order) setPreview({ id, order });
        say(movedMessage, id, order);
      } else if (event.key === ' ') {
        event.preventDefault();
        drop(id, held.order);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setPreview(null);
        say(cancelledMessage, id, latest.current.ids);
      }
    },
    onBlur: () => {
      if (latest.current.preview?.id !== id) return;
      setPreview(null);
      say(cancelledMessage, id, latest.current.ids);
    },
    onClick: event => {
      event.preventDefault();
      event.stopPropagation();
    },
  });

  const menuItems = (id: DaemonId, name: string): readonly ContextMenuItem[] => {
    const at = ids.indexOf(id);
    const step = (delta: -1 | 1, edge: DropEdge) => () => {
      const neighbour = ids[at + delta];
      if (neighbour === undefined) return;
      onMove(id, neighbour, edge);
      setAnnouncement(movedMessage(name, at + delta, ids.length));
    };
    return [
      { key: 'up', label: 'Move up', disabled: at <= 0, onSelect: step(-1, 'before') },
      { key: 'down', label: 'Move down', disabled: at >= ids.length - 1, onSelect: step(1, 'after') },
    ];
  };

  return { drawn: preview?.order ?? ids, dragging, over, announcement, gripProps, menuItems };
}

/** The grip and the "⋯" menu at the head of one machine's group. */
export function MachineHeadControls({
  id,
  name,
  reorder,
}: {
  readonly id: DaemonId;
  readonly name: string;
  readonly reorder: MachineReorder;
}) {
  const { touchAffected } = useInputModality();
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const menuButton = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <button
        className="fy-sbar__icon fy-sbar__machine-grip"
        data-machine-grip={id}
        title="Drag to reorder"
        type="button"
        {...reorder.gripProps(id, name)}
      >
        <GripVertical size={14} aria-hidden="true" />
      </button>
      <button
        aria-expanded={anchor !== null}
        aria-haspopup="menu"
        aria-label={`More for ${name}`}
        className="fy-sbar__icon fy-sbar__machine-more"
        onClick={() => {
          const box = menuButton.current?.getBoundingClientRect();
          setAnchor({ x: box?.left ?? 0, y: box?.bottom ?? 0 });
        }}
        ref={menuButton}
        type="button"
      >
        <Ellipsis size={14} aria-hidden="true" />
      </button>
      {anchor === null ? null : (
        <ContextMenu
          anchor={anchor}
          ariaLabel={`Move ${name}`}
          items={reorder.menuItems(id, name)}
          onClose={() => setAnchor(null)}
          open
          touch={touchAffected}
          triggerRef={menuButton}
        />
      )}
    </>
  );
}
