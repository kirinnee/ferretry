import { Cpu, User } from 'lucide-react';
import type { SessionView } from '@ferretry/protocol';
import { Badge } from '../shell/primitives.tsx';

const modeHint: Record<SessionView['config']['mode'], string> = {
  interactive: 'interactive — human-driven; never auto-nudged, auto-killed or flagged',
  auto: 'auto — autonomous; nudged at 180s of silence, killed at 300s, watched by the warden',
};

/**
 * The session mode is a quiet but consistent signal everywhere it appears.
 * Compact rows retain the icon and its full hover/accessibility label while
 * dropping the repeated word at narrow widths.
 */
export function ModeBadge({
  mode,
  size = 'md',
}: {
  readonly mode: SessionView['config']['mode'];
  readonly size?: 'sm' | 'md';
}) {
  const interactive = mode === 'interactive';
  const Icon = interactive ? User : Cpu;
  return (
    <Badge
      aria-label={modeHint[mode]}
      className={`fy-mode-badge ${interactive ? '' : 'fy-mode-badge-auto'}`}
      title={modeHint[mode]}
      tone={interactive ? 'accent' : 'pend'}
    >
      <Icon aria-hidden="true" size={11} />
      {size === 'md' ? mode : null}
    </Badge>
  );
}
