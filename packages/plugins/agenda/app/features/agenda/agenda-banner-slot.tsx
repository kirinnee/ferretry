/**
 * UNDER THE AGENDA HEADER: the `agenda.banner` slot this half offers (contract/slots.ts), where another plugin may put a
 * line that is about the whole page, not one ask. Access contributes "Notifications are off for <machine> on every
 * device — turn them on" (today's banner on the Inbox); it draws nothing when notifications are on. Nothing is drawn
 * where no panel is placed, or where its plugin is off on this machine.
 */

import { AGENDA_BANNER_SLOT } from '../../../contract/slots.ts';
import { PanelSlot, useSlotHasUsablePanels } from '../../shell.ts';

export function AgendaBannerSlot({ daemon }: { readonly daemon: string }) {
  const usable = useSlotHasUsablePanels(daemon, AGENDA_BANNER_SLOT);
  return usable ? <PanelSlot daemon={daemon} slot={AGENDA_BANNER_SLOT} /> : null;
}
