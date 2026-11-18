import { Menu } from 'lucide-react';
import { useRef, useState } from 'react';
import { useRouter } from '../router/router.tsx';
import { ContextMenu, type ContextMenuItem, type MenuAnchor } from '../ui/context-menu.tsx';
import { useInputModality } from '../ui/hooks/use-input-modality.ts';
import { paletteShortcutLabel } from '../ui/palette-shortcut.ts';
import { useShell } from './context.tsx';
import { useGoesByHostName, useMachineChoices } from './machine-switcher.tsx';
import { useNavTargets } from './nav-targets.ts';

/**
 * THE CHAT'S ONE SHELL BUTTON. On a ferret's own page the frame's bar of places, the machine switcher and Find are put
 * away (`.fy-frame[data-chat]`, shell.css) so the conversation keeps the window: this button, drawn at the start of the
 * ferret's own header row (the name, the status, Modes), opens ONE menu that holds all of them — Find, every place the bar
 * has, the machines (the one on screen marked "this one") and, for a machine that goes by its host name, "Name this
 * machine". Nothing is lost, it is one press further.
 *
 * It is positioned over the start of the header row (the row leaves room for it) so the page never moves under it: the
 * frame knows it is on a ferret's page from the route, before anything has loaded.
 */
export function ChatMenu({ daemon, onSearch }: { readonly daemon: string | undefined; readonly onSearch: () => void }) {
  const { runtime } = useShell();
  const router = useRouter();
  const trigger = useRef<HTMLButtonElement | null>(null);
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const { touchAffected } = useInputModality();
  const places = useNavTargets(daemon);
  const machines = useMachineChoices(daemon);
  const goesByHostName = useGoesByHostName(daemon);
  const items: readonly ContextMenuItem[] = [
    { key: 'find', label: 'Find', ...(touchAffected ? {} : { detail: paletteShortcutLabel() }), onSelect: onSearch },
    ...places.flatMap((place, index) =>
      place.to === undefined
        ? []
        : [
            {
              key: `place:${place.key}`,
              label: place.label,
              ...(place.current ? { detail: 'here' } : {}),
              separatorBefore: index === 0,
              onSelect: () => router.navigate(place.to as string),
            },
          ],
    ),
    ...machines.items.map((item, index) => (index === 0 ? { ...item, separatorBefore: true } : item)),
    ...(goesByHostName && daemon !== undefined
      ? [
          {
            key: 'name-this-machine',
            label: 'Name this machine',
            hint: 'It goes by its host name now.',
            separatorBefore: true,
            onSelect: () => runtime.daemons.askToName(daemon),
          },
        ]
      : []),
  ];
  return (
    <div className="fy-chat-menu-anchor">
      <button
        aria-expanded={anchor !== null}
        aria-haspopup="menu"
        aria-label={`Menu: places, machine (${machines.name}) and Find`}
        className="fy-chat-menu"
        data-chat-menu=""
        onClick={() => {
          const rect = trigger.current?.getBoundingClientRect();
          setAnchor({ x: rect?.left ?? 0, y: rect?.bottom ?? 0 });
        }}
        ref={trigger}
        title={machines.name}
        type="button"
      >
        <Menu aria-hidden="true" size={18} />
      </button>
      <ContextMenu
        anchor={anchor ?? { x: 0, y: 0 }}
        ariaLabel="Menu"
        items={items}
        onClose={() => setAnchor(null)}
        open={anchor !== null}
        touch={touchAffected}
        triggerRef={trigger}
      />
    </div>
  );
}
