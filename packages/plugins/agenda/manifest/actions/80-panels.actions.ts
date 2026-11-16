/** The panels Agenda mounts on other surfaces: the composer's agenda line, the nav's needs-you list, an agenda message's card, the device mute. */
import { manifestFragment, panel } from '@ferretry/kernel/manifest';
import { CONVERSATION_ROW_BODY_SLOT } from '@ferretry/plugin-conversation/contract';

export default manifestFragment({
  ui: {
    panels: [
      // The agenda line and its drawer, directly above the composer. The slot is Conversation's (its contract names it,
      // `CONVERSATION_ABOVE_COMPOSER_SLOT`); written out here as Claude Code writes it, and the shell's slot test pairs the names.
      panel('conversation.above-composer', { id: 'ferret-agenda-line', order: 40 }),
      // The ferrets waiting on the owner, under the nav entries (S4): device-level, in the column and the rail.
      panel('nav', { id: 'needs-you', order: 10 }),
      // An agenda message (an answer from a card, a reply naming `!A45`) as its card, in place of its words in the chat
      // (Conversation's `conversation.row-body` slot).
      panel(CONVERSATION_ROW_BODY_SLOT, { id: 'agenda-message', order: 10 }),
      // Settings › This device: one Mute per machine, right after Access's Notifications (order 30).
      panel('device.settings', { id: 'notification-mute', order: 31 }),
    ],
  },
});
