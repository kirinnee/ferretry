import { Menu } from 'lucide-react';
import { useShell } from './context.tsx';
import { drawerState } from './drawer-state.ts';

/**
 * THE CHAT'S ONE SHELL BUTTON, on a phone. A ferret's own page keeps the window for the conversation, so the phone's title bar
 * is not drawn there: this button, at the start of the ferret's own header row (the name, the status, Modes), opens the
 * same drawer the title bar's button opens elsewhere (Find, every place, the machines). On a wide screen the drawer is already
 * beside the chat, so nothing is drawn.
 *
 * It is positioned over the start of the header row (the row leaves room for it) so the page never moves under it: the
 * frame knows it is on a ferret's page from the route, before anything has loaded.
 */
export function ChatMenu() {
  const { viewport } = useShell();
  if (viewport !== 'phone') return null;
  return (
    <div className="fy-chat-menu-anchor">
      <button
        aria-haspopup="dialog"
        aria-label="Menu: places, machine and Find"
        className="fy-chat-menu"
        data-chat-menu=""
        onClick={() => drawerState.setOpen(true)}
        type="button"
      >
        <Menu aria-hidden="true" size={18} />
      </button>
    </div>
  );
}
