import { ShieldCheck } from 'lucide-react';
import type { ComponentType } from 'react';

import type { DaemonConnection } from '../daemon-connection.ts';

export interface WardenSurfaceProps {
  readonly connection: DaemonConnection;
}

export interface WardenConfigurationProps extends WardenSurfaceProps {
  readonly id: 'config';
}

export interface WardenPageSlots {
  readonly Attention: ComponentType<WardenSurfaceProps>;
  readonly Status: ComponentType<WardenSurfaceProps>;
  readonly Configuration: ComponentType<WardenConfigurationProps>;
  readonly Verdicts: ComponentType<WardenSurfaceProps>;
}

export interface WardenPageProps extends WardenSurfaceProps {
  readonly slots: WardenPageSlots;
}

/**
 * Route-level Warden composition. The concrete surfaces are supplied by the
 * component layer, while this shell owns their outcome-first order and keeps
 * one runtime daemon connection explicit at every boundary.
 */
export function WardenPage({ connection, slots }: WardenPageProps) {
  const { Attention, Status, Configuration, Verdicts } = slots;

  return (
    <div className="h-full min-h-0 w-full overflow-y-auto scroll-thin pb-4">
      <div className="mx-auto flex w-full max-w-[980px] flex-col gap-3 py-2">
        <div className="min-w-0">
          <h1 className="m-0 flex items-center gap-sm font-display text-display font-bold tracking-display">
            <ShieldCheck size={20} className="text-accent" aria-hidden="true" />
            Warden
          </h1>
          <p className="mt-0.5 text-ui text-muted">Who needs you, then sweeps, accounts, and recent verdicts.</p>
        </div>

        <Attention connection={connection} />
        <Status connection={connection} />
        <Configuration id="config" connection={connection} />
        <Verdicts connection={connection} />
      </div>
    </div>
  );
}
