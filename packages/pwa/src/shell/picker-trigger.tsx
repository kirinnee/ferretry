/**
 * ONE narrow-screen picker trigger, for every level of Settings navigation.
 *
 * Settings stacks three of these on a phone — the section, then the daemon, then that daemon's panel —
 * and each had been written separately as the same control: a 52px box with an eyebrow stacked over a
 * value and a chevron on the end. Three copies is how they drift; three STACKED copies is also most of
 * why the phone layout read as cluttered, because the real content began below 600px of chrome.
 *
 * So the eyebrow sits INLINE with its value rather than above it. That halves the height of each
 * trigger without dropping a word of what any of them says, and it is the shape the value deserves
 * anyway: "Settings section" is not a heading over a field, it is the name of what the value is.
 *
 * Deliberately presentational — it owns no open state and no sheet. The caller keeps both, because the
 * caller is the one that has a sheet to open, and the `aria-controls` target is the caller's id.
 */

import { ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../lib/class-names.ts';
import { EYEBROW } from './panel-typography.tsx';

export function PickerTrigger({
  eyebrow,
  value,
  icon,
  open,
  controls,
  marker,
  onOpen,
}: {
  /** What the value IS. The one uppercase role, per `panel-typography.tsx`. */
  readonly eyebrow: string;
  /** The current choice, and the thing a reader actually scans for. */
  readonly value: string;
  /** Optional, and drawn before the eyebrow; supply it already marked `aria-hidden`. */
  readonly icon?: ReactNode;
  readonly open: boolean;
  /** The id of the sheet this opens, for `aria-controls`. */
  readonly controls: string;
  /** The stable `data-*` attribute the harness and the suites locate this by, e.g. `data-daemon-panel-trigger`. */
  readonly marker: string;
  readonly onOpen: () => void;
}) {
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={controls}
      {...{ [marker]: '' }}
      onClick={onOpen}
      // `min-h-control` rather than a literal: the pointer-derived token already composes the 44px
      // touch floor with `max()`, so a coarse pointer gets it without this control knowing what a
      // pointer is, and a denser or looser theme moves with it.
      className="flex min-h-control w-full items-center gap-sm rounded-control border border-border bg-surface-2 px-control-x py-2 text-left focus-visible:outline-focus focus-visible:outline-offset-focus"
    >
      {icon}
      <span className={cn(EYEBROW, 'shrink-0')}>{eyebrow}</span>
      <span className="min-w-0 flex-1 truncate text-ui font-semibold text-fg">{value}</span>
      <ChevronDown size={16} className="shrink-0 text-muted" aria-hidden="true" />
    </button>
  );
}
