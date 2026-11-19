/**
 * THE LIST'S ⋯: one button beside Mine · All · Agents that holds what is the list's own but not worth a line of it —
 * "Show stopped" (a toggle with a check), "Group Needs you at the top" (the device's own setting, a toggle too), and
 * "Restart outdated (N)" while any ferret is outdated (or a press is in flight). The ⋯ wears the outdated count as a
 * small badge, so the one thing a reader may need without having looked is findable.
 */
import { ContextMenu, type ContextMenuItem, type MenuAnchor, useInputModality } from '@ferretry/app/ui';
import { Ellipsis, Eye, Pin, RotateCw } from 'lucide-react';
import { useRef, useState } from 'react';
import { restartButtonLabel } from './outdated-model.ts';
import type { RestartOutdated } from './restart-outdated.tsx';

/** What the ⋯ toggles: the device's two list switches, with how many stopped ferrets the first would add. */
export interface ListToggles {
  readonly showStopped: boolean;
  /** Stopped ferrets the kind chosen is hiding right now (0 while they are shown). */
  readonly hiddenStopped: number;
  readonly onShowStopped: (on: boolean) => void;
  readonly groupNeedsYou: boolean;
  readonly onGroupNeedsYou: (on: boolean) => void;
}

export function ListOptions({
  restart,
  toggles,
}: {
  readonly restart: RestartOutdated;
  readonly toggles: ListToggles;
}) {
  const trigger = useRef<HTMLButtonElement | null>(null);
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const { touchAffected } = useInputModality();
  const outdated = restart.count;
  const items: ContextMenuItem[] = [
    {
      key: 'show-stopped',
      label: 'Show stopped',
      icon: <Eye aria-hidden="true" size={14} />,
      ...(toggles.hiddenStopped > 0 ? { detail: `(${toggles.hiddenStopped})` } : {}),
      checked: toggles.showStopped,
      onSelect: () => toggles.onShowStopped(!toggles.showStopped),
    },
    {
      key: 'group-needs-you',
      label: 'Group Needs you at the top',
      icon: <Pin aria-hidden="true" size={14} />,
      checked: toggles.groupNeedsYou,
      onSelect: () => toggles.onGroupNeedsYou(!toggles.groupNeedsYou),
    },
    ...(outdated === 0 && !restart.running
      ? []
      : [
          {
            key: 'restart-outdated',
            label: restart.running ? 'Restarting…' : restartButtonLabel(outdated),
            icon: <RotateCw aria-hidden="true" size={14} />,
            hint: 'Keeps each conversation. A busy ferret waits for its next idle moment.',
            disabled: restart.running,
            onSelect: restart.press,
            separatorBefore: true,
          },
        ]),
  ];
  return (
    <>
      <button
        aria-expanded={anchor !== null}
        aria-haspopup="menu"
        aria-label={`Ferret list options${outdated > 0 ? `. ${outdated} outdated` : ''}`}
        className="fy-sbar__options"
        data-sbar-options=""
        onClick={() => {
          const rect = trigger.current?.getBoundingClientRect();
          setAnchor({ x: rect?.left ?? 0, y: rect?.bottom ?? 0 });
        }}
        ref={trigger}
        title={outdated > 0 ? `${outdated} outdated — open to restart` : 'List options'}
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
        ariaLabel="Ferret list options"
        items={items}
        onClose={() => setAnchor(null)}
        open={anchor !== null}
        touch={touchAffected}
        triggerRef={trigger}
      />
    </>
  );
}
