/**
 * THE FRAME AROUND A SURFACE THAT CAN FILL THE SCREEN (a browser page).
 *
 * It owns the full-screen state and hands the host one node, `controls`: the agent-control
 * marker followed by the Full screen button. The host puts that in the row it already has —
 * the browser's page strip — so full screen costs a button, not a bar. A host with no row
 * of its own gets one slim bar here instead, the only case where the frame adds
 * height, and then only the ~32px the controls need.
 *
 * Full screen is the frame's whole element, so everything inside — the strip, the page —
 * comes with it; the stylesheet then folds the strip down to its controls row.
 */

import type { ReactNode } from 'react';
import { FullscreenToggle } from '../../components/fullscreen-toggle.tsx';
import { useFullscreen } from '../../hooks/use-fullscreen.ts';

export interface SurfaceFrameProps {
  /** The agent-control marker for this surface; renders nothing while nobody drives it. */
  readonly marker: ReactNode;
  /** The host draws `controls` itself. Otherwise the frame draws them in a slim bar of its own. */
  readonly hostsControls: boolean;
  readonly dataBrowser: string;
  readonly children: (controls: ReactNode) => ReactNode;
}

export function SurfaceFrame({ marker, hostsControls, dataBrowser, children }: SurfaceFrameProps) {
  const fullscreen = useFullscreen<HTMLDivElement>();
  const controls = (
    <>
      {marker}
      <FullscreenToggle active={fullscreen.active} onToggle={fullscreen.toggle} />
    </>
  );
  return (
    <div
      className="fy-ws-frame relative flex min-h-0 flex-1 flex-col"
      data-fullscreen={fullscreen.active ? '' : undefined}
      data-workspace-browser={dataBrowser}
      ref={fullscreen.ref}
    >
      {hostsControls ? null : <div className="fy-ws-bar">{controls}</div>}
      {children(hostsControls ? controls : null)}
    </div>
  );
}
