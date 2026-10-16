/**
 * ONE RESIZE SEPARATOR for every workspace boundary: the divider between two
 * panes (a RATIO of the split it sits in) and the edge of a side rail (a width
 * in PIXELS). It generalises the side pane's resize handle
 * (`shell/side-pane-resize-handle.tsx`) to both axes and both units:
 *
 *   - the WAI-ARIA window-splitter pattern — a focusable `role=separator` with
 *     aria-valuenow/min/max, arrow keys (Shift for a larger step), Home / End;
 *   - pointer drag that PREVIEWS at most once per `DIVIDER_THROTTLE_MS` and
 *     COMMITS exactly once when the drag ends, so persistence sees one write;
 *   - double-click resets to the default.
 */

import { useEffect, useRef } from 'react';
import {
  clampWorkspaceRailWidth,
  WORKSPACE_RAIL_BOUNDS,
  type WorkspaceRailSide,
} from '../../lib/workspace-rail-preferences.ts';

export const DIVIDER_THROTTLE_MS = 50;

export type SplitDividerAxis = 'row' | 'column';

export interface SplitDividerProps {
  /** `row`: the panes sit side by side, so the bar is vertical and moves on X. */
  readonly axis: SplitDividerAxis;
  /** `ratio`: value is a share of the parent container. `px`: value is pixels. */
  readonly unit: 'ratio' | 'px';
  readonly value: number;
  readonly min: number;
  readonly max: number;
  /** Double-click target. */
  readonly defaultValue: number;
  /** One arrow-key step, in the value's unit; Shift multiplies it by four. */
  readonly step: number;
  /** Dragging toward the start (left/up) GROWS the value — a right-hand rail. */
  readonly inverted?: boolean;
  readonly label: string;
  readonly onPreview: (value: number) => void;
  readonly onCommit: (value: number) => void;
  readonly className?: string;
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

interface DragState {
  readonly pointerId: number;
  readonly startClient: number;
  readonly startValue: number;
  /** Pixels per unit of value along the axis. */
  readonly scale: number;
  pending: number;
  moved: boolean;
  lastPreviewAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/** Arrow keys along the divider's axis; everything else is not ours. */
export const dividerValueFromKey = (
  key: string,
  props: Pick<SplitDividerProps, 'axis' | 'value' | 'min' | 'max' | 'step' | 'inverted'>,
  largeStep: boolean,
): number | null => {
  const step = (largeStep ? 4 : 1) * props.step * (props.inverted ? -1 : 1);
  const [back, forward] = props.axis === 'row' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
  if (key === forward) return clamp(props.value + step, props.min, props.max);
  if (key === back) return clamp(props.value - step, props.min, props.max);
  if (key === 'Home') return props.min;
  if (key === 'End') return props.max;
  return null;
};

const ariaNumber = (unit: SplitDividerProps['unit'], value: number): number =>
  unit === 'ratio' ? Math.round(value * 100) : Math.round(value);

export function SplitDivider(props: SplitDividerProps) {
  const { axis, unit, value, min, max, defaultValue, inverted, label, onPreview, onCommit } = props;
  const dragRef = useRef<DragState | null>(null);

  useEffect(
    () => () => {
      const drag = dragRef.current;
      if (drag?.timer) clearTimeout(drag.timer);
      dragRef.current = null;
    },
    [],
  );

  const preview = (drag: DragState, next: number) => {
    drag.pending = next;
    const remaining = DIVIDER_THROTTLE_MS - (Date.now() - drag.lastPreviewAt);
    if (remaining <= 0) {
      if (drag.timer) clearTimeout(drag.timer);
      drag.timer = null;
      drag.lastPreviewAt = Date.now();
      onPreview(next);
      return;
    }
    if (drag.timer) return;
    drag.timer = setTimeout(() => {
      if (dragRef.current !== drag) return;
      drag.timer = null;
      drag.lastPreviewAt = Date.now();
      onPreview(drag.pending);
    }, remaining);
  };

  const finish = (element: HTMLElement, pointerId: number) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== pointerId) return;
    if (drag.timer) clearTimeout(drag.timer);
    dragRef.current = null;
    if (drag.moved) {
      onPreview(drag.pending);
      onCommit(drag.pending);
    }
    if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
  };

  const clientOf = (event: { clientX: number; clientY: number }) => (axis === 'row' ? event.clientX : event.clientY);
  const shown = clamp(value, min, max);
  const percent = ariaNumber(unit, shown);

  return (
    // The window-splitter pattern needs a FOCUSABLE separator; <hr> cannot take
    // focus, keyboard commands or a pointer capture.
    // biome-ignore lint/a11y/useSemanticElements: a window splitter must be focusable; hr cannot be.
    <button
      type="button"
      role="separator"
      aria-label={label}
      aria-orientation={axis === 'row' ? 'vertical' : 'horizontal'}
      aria-valuemin={ariaNumber(unit, min)}
      aria-valuemax={ariaNumber(unit, max)}
      aria-valuenow={percent}
      aria-valuetext={unit === 'ratio' ? `${percent}% and ${100 - percent}%` : `${percent} pixels`}
      title={`${label} (arrow keys; Shift for larger steps; double-click to reset)`}
      data-axis={axis}
      className={`fy-ws-divider${props.className ? ` ${props.className}` : ''}`}
      onPointerDown={event => {
        if (event.button !== 0) return;
        const container = event.currentTarget.parentElement;
        const rect = container?.getBoundingClientRect();
        const size = rect ? (axis === 'row' ? rect.width : rect.height) : 0;
        const scale = unit === 'px' ? 1 : size;
        if (!(scale > 0)) return;
        event.preventDefault();
        dragRef.current = {
          pointerId: event.pointerId,
          startClient: clientOf(event),
          startValue: shown,
          scale,
          pending: shown,
          moved: false,
          lastPreviewAt: 0,
          timer: null,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={event => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        event.preventDefault();
        const delta = ((clientOf(event) - drag.startClient) / drag.scale) * (inverted ? -1 : 1);
        const next = clamp(drag.startValue + delta, min, max);
        if (next === drag.pending) return;
        drag.moved = true;
        preview(drag, next);
      }}
      onPointerUp={event => finish(event.currentTarget, event.pointerId)}
      onPointerCancel={event => finish(event.currentTarget, event.pointerId)}
      onLostPointerCapture={event => finish(event.currentTarget, event.pointerId)}
      onKeyDown={event => {
        const next = dividerValueFromKey(event.key, props, event.shiftKey);
        if (next === null) return;
        event.preventDefault();
        onPreview(next);
        onCommit(next);
      }}
      onDoubleClick={() => {
        const reset = clamp(defaultValue, min, max);
        onPreview(reset);
        onCommit(reset);
      }}
    >
      <span aria-hidden="true" className="fy-ws-divider-line" />
    </button>
  );
}

export interface RailDividerProps {
  readonly side: WorkspaceRailSide;
  readonly width: number;
  readonly onPreview: (width: number) => void;
  readonly onCommit: (width: number) => void;
}

/** The inner edge of a side rail. The right rail grows as its edge moves left. */
export function RailDivider({ side, width, onPreview, onCommit }: RailDividerProps) {
  const bounds = WORKSPACE_RAIL_BOUNDS[side];
  return (
    <SplitDivider
      axis="row"
      unit="px"
      value={clampWorkspaceRailWidth(side, width)}
      min={bounds.min}
      max={bounds.max}
      defaultValue={bounds.initial}
      step={16}
      inverted={side === 'right'}
      label={side === 'left' ? 'Resize agents rail' : 'Resize context rail'}
      onPreview={onPreview}
      onCommit={onCommit}
      className={`fy-ws-rail-divider fy-ws-rail-divider--${side}`}
    />
  );
}
