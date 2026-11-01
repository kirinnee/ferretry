/**
 * THE FRAME AROUND A SURFACE THAT CAN FILL THE SCREEN (a browser page).
 *
 * It owns the full-screen state and hands the host the toggle, which the browser bar carries in its ⋯
 * menu — so full screen costs a menu entry, not a bar. Full screen is the frame's whole element, so
 * everything inside — the bar, the page — comes with it.
 */

import type { ReactNode } from 'react';
import { useFullscreen } from '../../hooks/use-fullscreen.ts';

export interface SurfaceFullscreen {
  readonly active: boolean;
  readonly toggle: () => void;
}

export interface SurfaceFrameProps {
  readonly dataBrowser: string;
  readonly children: (fullscreen: SurfaceFullscreen) => ReactNode;
}

export function SurfaceFrame({ dataBrowser, children }: SurfaceFrameProps) {
  const fullscreen = useFullscreen<HTMLDivElement>();
  return (
    <div
      className="fy-ws-frame relative flex min-h-0 flex-1 flex-col"
      data-fullscreen={fullscreen.active ? '' : undefined}
      data-workspace-browser={dataBrowser}
      ref={fullscreen.ref}
    >
      {children({ active: fullscreen.active, toggle: fullscreen.toggle })}
    </div>
  );
}
