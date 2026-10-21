/**
 * THE SESSIONS BAR'S OPTIONS: a "⋯" in the bar's header with the one choice that is the bar's own, how much
 * a row says. It writes the same device setting as Settings › Appearance › Density, so the two never disagree.
 */

import { Check, Ellipsis } from 'lucide-react';
import { useRef, useState } from 'react';
import { useInputModality } from '../hooks/use-input-modality.ts';
import type { Density } from '../lib/controls.ts';
import { ContextMenu, type ContextMenuItem, type MenuAnchor } from './context-menu.tsx';

const mark = (on: boolean) =>
  on ? <Check aria-hidden="true" size={14} /> : <span aria-hidden="true" className="inline-block w-[14px]" />;

/** The two rows the menu offers, each saying whether it is the one in force. */
const densityMenuItems = (compact: boolean, onChange: (density: Density) => void): readonly ContextMenuItem[] => [
  {
    key: 'compact',
    label: 'Compact',
    icon: mark(compact),
    ...(compact ? { detail: 'current' } : {}),
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

export function SessionsBarOptions({
  compact,
  onChange,
}: {
  readonly compact: boolean;
  readonly onChange: (density: Density) => void;
}) {
  const trigger = useRef<HTMLButtonElement | null>(null);
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const { touchAffected } = useInputModality();
  return (
    <>
      <button
        aria-expanded={anchor !== null}
        aria-haspopup="menu"
        aria-label="Sessions bar options"
        className="fy-sbar__icon"
        data-sbar-options=""
        onClick={() => {
          const rect = trigger.current?.getBoundingClientRect();
          setAnchor({ x: rect?.left ?? 0, y: rect?.bottom ?? 0 });
        }}
        ref={trigger}
        title="Row density"
        type="button"
      >
        <Ellipsis aria-hidden="true" size={16} />
      </button>
      <ContextMenu
        anchor={anchor ?? { x: 0, y: 0 }}
        ariaLabel="Row density"
        items={densityMenuItems(compact, onChange)}
        onClose={() => setAnchor(null)}
        open={anchor !== null}
        touch={touchAffected}
        triggerRef={trigger}
      />
    </>
  );
}
