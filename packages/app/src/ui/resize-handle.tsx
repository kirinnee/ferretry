import { type KeyboardEvent, type PointerEvent, useLayoutEffect, useRef, useState } from 'react';
import {
  clampWidth,
  KEY_STEP,
  measureMax,
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
 * (`shell/panel-widths.ts`); this component only moves it. It always starts from the width the panel is DRAWN at (a saved width
 * can be wider than the window allows, and the drawn one is what a reader sees and a screen reader must hear), and it announces
 * the real room there is, not only the panel's range.
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

/** What is drawn now: the panel's width and the most it can be. Re-read after every render and when the window or its row resizes. */
function useDrawn(panel: PanelId, chosen: number | undefined) {
  const range = PANEL_RANGES[panel];
  const read = () => ({
    width: measurePanel(panel) ?? chosen ?? range.min,
    max: measureMax(panel),
  });
  const [drawn, setDrawn] = useState(read);
  // No dependency list: any render may have changed what is drawn. The state only moves when a number did.
  useLayoutEffect(() => {
    const refresh = (): void => {
      const next = read();
      setDrawn(previous => (previous.width === next.width && previous.max === next.max ? previous : next));
    };
    refresh();
    window.addEventListener('resize', refresh);
    return () => window.removeEventListener('resize', refresh);
  });
  return drawn;
}

export function ResizeHandle({ panel, edge, label }: ResizeHandleProps) {
  const chosen = usePanelWidth(panel);
  const drawn = useDrawn(panel, chosen);
  const drag = useRef<{ readonly x: number; readonly width: number } | null>(null);
  const range = PANEL_RANGES[panel];
  // The side that makes the panel wider: away from the page the panel is beside.
  const grow = edge === 'end' ? 1 : -1;

  // Read at the moment of the act (the window may have moved since the last render), and held to the room there is.
  const current = (): number => measurePanel(panel) ?? chosen ?? range.min;
  const place = (width: number): number => Math.min(measureMax(panel), width);

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
    panelWidths.preview(panel, place(start.width + grow * (event.clientX - start.x)));
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
    panelWidths.set(panel, place(current() + direction * (edge === 'end' ? 1 : -1) * KEY_STEP));
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
      aria-valuemax={drawn.max}
      aria-valuenow={Math.min(drawn.max, clampWidth(panel, drawn.width))}
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
