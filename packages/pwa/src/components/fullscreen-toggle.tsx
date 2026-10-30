/**
 * The full-screen control every surface carries: the same icon, the same words and the
 * same tooltip on a shell and on a browser page. Presentational; `useFullscreen` owns the state.
 */

import { Maximize2, Minimize2 } from 'lucide-react';
import { Button } from '../shell/primitives.tsx';

export interface FullscreenToggleProps {
  readonly active: boolean;
  readonly onToggle: () => void;
}

export function FullscreenToggle({ active, onToggle }: FullscreenToggleProps) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="fy-surface-icon"
      aria-label={active ? 'Exit full screen' : 'Full screen'}
      aria-pressed={active}
      title={active ? 'Exit full screen (Esc, or Shift+Esc while typing in it)' : 'Full screen'}
      onClick={onToggle}
    >
      {active ? <Minimize2 aria-hidden="true" size={14} /> : <Maximize2 aria-hidden="true" size={14} />}
    </Button>
  );
}
