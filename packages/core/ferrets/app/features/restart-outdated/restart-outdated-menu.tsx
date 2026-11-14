/**
 * THE LIST'S ⋯: one button in the list head that holds what is the list's own but not worth a line of it — here, "Restart
 * outdated (N)". The ⋯ wears the count as a small badge while any ferret is outdated, so the one thing a reader may need
 * without having looked is findable. Drawn only while something is outdated (or a press is in flight).
 */
import { ContextMenu, type MenuAnchor, useInputModality } from '@ferretry/app/ui';
import { Ellipsis, RotateCw } from 'lucide-react';
import { useRef, useState } from 'react';
import { restartButtonLabel } from './outdated-model.ts';
import type { RestartOutdated } from './restart-outdated.tsx';

export function ListOptions({ restart }: { readonly restart: RestartOutdated }) {
  const trigger = useRef<HTMLButtonElement | null>(null);
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const { touchAffected } = useInputModality();
  const outdated = restart.count;
  if (outdated === 0 && !restart.running) return null;
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
        title={outdated > 0 ? `${outdated} outdated — open to restart` : 'Restarting…'}
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
        items={[
          {
            key: 'restart-outdated',
            label: restart.running ? 'Restarting…' : restartButtonLabel(outdated),
            icon: <RotateCw aria-hidden="true" size={14} />,
            hint: 'Keeps each conversation. A busy ferret waits for its next idle moment.',
            disabled: restart.running,
            onSelect: restart.press,
          },
        ]}
        onClose={() => setAnchor(null)}
        open={anchor !== null}
        touch={touchAffected}
        triggerRef={trigger}
      />
    </>
  );
}
