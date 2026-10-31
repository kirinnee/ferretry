import type { ComponentType } from 'react';
import { WardenDaemonFilter } from '../../features/warden/warden-daemon-filter.tsx';
import { resolveWardenScope, type WardenMachine } from '../../features/warden/warden-daemon-scope.ts';
import type { DaemonConnection } from '../daemon-connection.ts';

export interface WardenSurfaceProps {
  readonly connection: DaemonConnection;
  /** Which daemon this is, set only when the page shows more than one daemon's worth of choice. */
  readonly machineName?: string;
}

export interface WardenPageSlots {
  /** The whole page body: status line, groups and histories, bound to one daemon. */
  readonly Overview: ComponentType<WardenSurfaceProps>;
}

export interface WardenPageProps extends WardenSurfaceProps {
  readonly slots: WardenPageSlots;
  /** Every paired daemon, in the order the sessions bar shows them. Absent: the page shows `connection` alone. */
  readonly machines?: readonly WardenMachine[];
  /** The daemon this device last narrowed the page to; `null` = All. */
  readonly remembered?: string | null;
  readonly onRemember?: (daemonId: string | null) => void;
}

/**
 * Route-level Warden composition, inside the Insights frame. The concrete surface is supplied by the
 * component layer; this shell owns the scroll region, the daemon filter and which daemons get a body.
 * Each body is bound to ONE daemon, so nothing read from one is shown or acted on through another.
 * Settings live in Settings › Warden, not here.
 */
export function WardenPage({ connection, slots, machines, remembered = null, onRemember }: WardenPageProps) {
  const { Overview } = slots;
  const scope = machines === undefined ? undefined : resolveWardenScope(machines, remembered);
  return (
    <main
      aria-label="Warden"
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain scroll-thin"
      data-warden-page=""
    >
      {scope?.offerFilter === true && machines !== undefined ? (
        <WardenDaemonFilter machines={machines} selected={scope.selected} onChoose={id => onRemember?.(id)} />
      ) : null}
      {scope?.offerFilter === true ? (
        scope.shown.map(machine => (
          <Overview key={machine.connection.daemonId} connection={machine.connection} machineName={machine.name} />
        ))
      ) : (
        <Overview connection={scope?.shown[0]?.connection ?? connection} />
      )}
    </main>
  );
}
