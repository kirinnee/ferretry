/**
 * THE SESSIONS BAR'S OPTIONS: a "⋯" in the bar's header that holds what is the bar's own but not worth a line
 * of the list: whether stopped sessions are listed, "Restart outdated (N)", and how much a row says.
 *
 * The density choice writes the same device setting as Settings › Appearance › Density, so the two never
 * disagree. Restart outdated is the one thing here a reader may need without having looked, so the ⋯ wears the
 * count as a small badge while any ferret is outdated.
 */

import { Check, Ellipsis, RotateCw } from 'lucide-react';
import { useRef, useState } from 'react';
import { restartButtonLabel } from '../features/restart-outdated/outdated-model.ts';
import type { RestartOutdated } from '../features/restart-outdated/restart-outdated-strip.tsx';
import { useInputModality } from '../hooks/use-input-modality.ts';
import type { Density } from '../lib/controls.ts';
import { ContextMenu, type ContextMenuItem, type MenuAnchor } from './context-menu.tsx';

const mark = (on: boolean) =>
  on ? <Check aria-hidden="true" size={14} /> : <span aria-hidden="true" className="inline-block w-[14px]" />;

/** The two rows the density choice offers, each saying whether it is the one in force. */
const densityMenuItems = (compact: boolean, onChange: (density: Density) => void): readonly ContextMenuItem[] => [
  {
    key: 'compact',
    label: 'Compact',
    icon: mark(compact),
    ...(compact ? { detail: 'current' } : {}),
    separatorBefore: true,
    onSelect: () => onChange('compact'),
  },
  {
    key: 'comfortable',
    label: 'Comfortable',
    icon: mark(!compact),
    ...(compact ? {} : { detail: 'current' }),
    onSelect: () => onChange('full'),
  },
];

export interface SessionsBarOptionsProps {
  readonly showStopped: boolean;
  /** Stopped sessions the list is not drawing, said beside the row so the choice has a number. */
  readonly hiddenStopped: number;
  readonly onShowStoppedChange: (showStopped: boolean) => void;
  /** Absent when the host cannot restart; the row is then never offered. */
  readonly restart: RestartOutdated;
  /** Absent when the host cannot store a density: the rows are then not offered. */
  readonly density?: { readonly compact: boolean; readonly onChange: (density: Density) => void };
}

const menuItems = (props: SessionsBarOptionsProps): readonly ContextMenuItem[] => {
  const { restart, showStopped, hiddenStopped, density } = props;
  return [
    {
      key: 'show-stopped',
      label: 'Show stopped',
      icon: mark(showStopped),
      hint: 'Completed, failed, stalled or stopped sessions',
      ...(showStopped || hiddenStopped === 0 ? {} : { detail: hiddenStopped }),
      onSelect: () => props.onShowStoppedChange(!showStopped),
    },
    ...(restart.available && restart.count > 0
      ? [
          {
            key: 'restart-outdated',
            label: restart.running ? 'Restarting…' : restartButtonLabel(restart.count),
            icon: <RotateCw aria-hidden="true" size={14} />,
            hint: 'Keeps each conversation. A busy ferret waits for its next idle moment.',
            disabled: restart.running,
            onSelect: restart.press,
          },
        ]
      : []),
    ...(density === undefined ? [] : densityMenuItems(density.compact, density.onChange)),
  ];
};

export function SessionsBarOptions(props: SessionsBarOptionsProps) {
  const trigger = useRef<HTMLButtonElement | null>(null);
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const { touchAffected } = useInputModality();
  const outdated = props.restart.available ? props.restart.count : 0;
  return (
    <>
      <button
        aria-expanded={anchor !== null}
        aria-haspopup="menu"
        aria-label={`Sessions bar options${outdated > 0 ? `. ${outdated} outdated` : ''}`}
        className="fy-sbar__icon fy-sbar__options"
        data-sbar-options=""
        onClick={() => {
          const rect = trigger.current?.getBoundingClientRect();
          setAnchor({ x: rect?.left ?? 0, y: rect?.bottom ?? 0 });
        }}
        ref={trigger}
        title={outdated > 0 ? `${outdated} outdated — open to restart` : 'Show stopped, restart outdated, row density'}
        type="button"
      >
        <Ellipsis aria-hidden="true" size={16} />
        {outdated > 0 ? (
          <span aria-hidden="true" className="fy-sbar__options-badge" data-sbar-options-badge="">
            {outdated}
          </span>
        ) : null}
      </button>
      <ContextMenu
        anchor={anchor ?? { x: 0, y: 0 }}
        ariaLabel="Sessions bar options"
        items={menuItems(props)}
        onClose={() => setAnchor(null)}
        open={anchor !== null}
        touch={touchAffected}
        triggerRef={trigger}
      />
    </>
  );
}
