/**
 * Add a login › Environment's first screen (docs/provider-presets.md): one tile per provider this
 * machine offers, in the daemon's order — its name, which CLIs it drives, one line on what it is — and
 * one tap opens the minimal form that asks only for its key. A provider that is not offered here says
 * why and cannot be tapped. Last come the custom gateway and **Paste variables…**, which recognises the
 * provider from a block of variables a person already has.
 */

import type { FleetProviderPresetView } from '@ferretry/protocol';
import { ClipboardPaste } from 'lucide-react';
import { presetScope } from './environment-model.ts';
import { LoginScopeChip } from './login-scope-chip.tsx';
import { gridPresets } from './provider-model.ts';

const TILE =
  'kt-panel flex min-h-control min-w-0 flex-col items-start gap-1 p-panel text-left hover:border-accent disabled:cursor-not-allowed disabled:hover:border-border';

export interface ProviderGridProps {
  readonly presets: readonly FleetProviderPresetView[];
  readonly onPick: (presetId: string) => void;
  readonly onPaste: () => void;
}

export function ProviderGrid({ presets, onPick, onPaste }: ProviderGridProps) {
  return (
    <ul
      className="m-0 grid list-none gap-2 p-0 [grid-template-columns:repeat(auto-fill,minmax(min(100%,15rem),1fr))]"
      data-provider-grid=""
    >
      {gridPresets(presets).map(preset => (
        <li key={preset.id} className="flex min-w-0">
          <button
            type="button"
            className={`${TILE} flex-1`}
            disabled={!preset.offered.available}
            data-provider-tile={preset.id}
            onClick={() => onPick(preset.id)}
          >
            <span className="flex w-full min-w-0 flex-wrap items-center justify-between gap-1">
              <span className="min-w-0 break-words text-row font-semibold text-fg">{preset.label}</span>
              <LoginScopeChip harnesses={presetScope(preset)} />
            </span>
            <span className="line-clamp-2 text-cell leading-base text-muted">{preset.summary}</span>
            {preset.offered.available ? null : (
              <span className="text-cell leading-base text-warn" data-provider-tile-reason="">
                Not offered here: {preset.offered.reason}
              </span>
            )}
          </button>
        </li>
      ))}
      <li className="flex min-w-0">
        <button type="button" className={`${TILE} flex-1 border-dashed`} data-provider-tile="paste" onClick={onPaste}>
          <span className="inline-flex items-center gap-2 text-row font-semibold text-fg">
            <ClipboardPaste size={16} aria-hidden="true" className="shrink-0 text-accent" />
            Paste variables…
          </span>
          <span className="text-cell leading-base text-muted">
            Paste the variables you already use; the provider is recognised right here in the browser.
          </span>
        </button>
      </li>
    </ul>
  );
}
