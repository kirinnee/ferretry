import { type KeyboardEvent, type PointerEvent, useRef } from 'react';
import {
  clampWidth,
  KEY_STEP,
  measurePanel,
  PANEL_RANGES,
  type PanelId,
  panelWidths,
  usePanelWidth,
} from '../shell/panel-widths.ts';
import './resize-handle.css';

/**
 * THE GRAB STRIP ON A PANEL'S EDGE (r10 S3): a 2 px line in an 18 px hit area. Drag it with a pointer, or focus it and use
 * ←/→ (16 px a press), Home to put the panel back, a double-click likewise. The width is the panel's, saved per device
 * (`shell/panel-widths.ts`); this component only moves it.
 *
 * `edge` is the side of the PANEL the strip sits on: a column on the right of the page has it on its `start`, so dragging
 * left makes it wider; the drawer and the settings list have it on their `end`. A phone's panels are overlays and take
 * no handle: the caller does not draw one.
 */

export interface ResizeHandleProps {
  readonly panel: PanelId;
  readonly edge: 'start' | 'end';
  /** What a screen reader calls the panel ("side column"). */
  readonly label: string;
}

export function ResizeHandle({ panel, edge, label }: ResizeHandleProps) {
  const chosen = usePanelWidth(panel);
  const drag = useRef<{ readonly x: number; readonly width: number } | null>(null);
  const range = PANEL_RANGES[panel];
  // The side that makes the panel wider: away from the page the panel is beside.
  const grow = edge === 'end' ? 1 : -1;

  const current = (): number => chosen ?? measurePanel(panel) ?? range.min;

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    drag.current = { x: event.clientX, width: current() };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    document.documentElement.setAttribute('data-panel-resizing', panel);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const start = drag.current;
    if (start === null) return;
    panelWidths.preview(panel, start.width + grow * (event.clientX - start.x));
  };
  const end = (event: PointerEvent<HTMLDivElement>): void => {
    if (drag.current === null) return;
    drag.current = null;
    document.documentElement.removeAttribute('data-panel-resizing');
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    panelWidths.commit();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Home') {
      event.preventDefault();
      panelWidths.reset(panel);
      return;
    }
    const direction = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (direction === 0) return;
    event.preventDefault();
    // → moves the edge right: wider for a panel whose strip is on its right, narrower for one whose strip is on its left.
    panelWidths.set(panel, current() + direction * (edge === 'end' ? 1 : -1) * KEY_STEP);
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: a FOCUSABLE separator is a window splitter (ARIA APG); `<hr>` is not interactive.
    <div
      className={`fy-resize fy-resize--${panel}`}
      data-resize-handle={panel}
      data-edge={edge}
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize the ${label}`}
      aria-valuemin={range.min}
      aria-valuemax={range.max}
      aria-valuenow={clampWidth(panel, current())}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => panelWidths.reset(panel)}
      onKeyDown={onKeyDown}
    />
  );
}
