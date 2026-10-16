import type { ComponentType } from 'react';

import type { DaemonConnection } from '../daemon-connection.ts';

export interface WardenSurfaceProps {
  readonly connection: DaemonConnection;
}

export interface WardenPageSlots {
  /** The whole page body: status line, groups and histories, bound to one daemon. */
  readonly Overview: ComponentType<WardenSurfaceProps>;
}

export interface WardenPageProps extends WardenSurfaceProps {
  readonly slots: WardenPageSlots;
}

/**
 * Route-level Warden composition, inside the Insights frame. The concrete surface is supplied by the
 * component layer; this shell owns the scroll region and keeps the one daemon connection explicit at
 * the boundary. Settings live in Settings › Warden, not here.
 */
export function WardenPage({ connection, slots }: WardenPageProps) {
  const { Overview } = slots;
  return (
    <main
      aria-label="Warden"
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain scroll-thin"
      data-warden-page=""
    >
      <Overview connection={connection} />
    </main>
  );
}
