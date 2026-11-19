/**
 * What Conversation draws: its screens, its panels in other pages' slots, its settings tab and its renderer.
 *
 * One fragment, not one per feature: a panel's place in `ui.panels` is part of the built manifest and the panels of one
 * feature are not contiguous (the queue, the turn mark and the interrupt row are interleaved with other features'), so
 * splitting them would move an entry. A new feature's panel is a line here until the order is no longer pinned.
 */
import { panel, renderer, screen, settingsTab } from '@ferretry/kernel/manifest';
import { AGENDA_CONVERSATION_SLOT, CONVERSATION_MODES_SLOT } from '../../contract/index.ts';
import { ACTIONS_ROW_SLOT, FILES_SEARCH_SLOT } from '@ferretry/core-ferrets/contract';
import { fragment } from '../kit.ts';

export default fragment({
  ui: {
    screens: [
      // The chat offers three slots of its own (`contract/slots.ts`): `conversation.row` after each transcript row,
      // `conversation.row-body` in place of a person's own words (Agenda's card) and `conversation.row-actions` in a row's actions, each with `{ entry }` (only {id, kind, text, at?, label?, tools?}; `tools` are
      // a tool row's shell commands) and the ferret as subject — Voice's read-aloud and Packs' card draw there. It mounts `ferret.toolbar` and
      // `ferret.side` with the ferret as subject.
      screen('chat', { path: 'ferrets/:ferret/chat' }),
      screen('links', { path: 'links', nav: { label: 'Conversations', icon: 'messages', order: 25 } }),
      // Every ferret's queue on this machine (v4's "All queues"), opened from a ferret's queue panel; no nav entry of its own.
      screen('queues', { path: 'queues' }),
    ],
    panels: [
      panel('composer.tools', { id: 'attachments', order: 10 }),
      panel('ferret.side', { id: 'queue', order: 10 }),
      // The modes (Compact memory at, Hypermedia) live in the header's Modes menu, not on its main line.
      panel(CONVERSATION_MODES_SLOT, { id: 'compact-at', order: 30 }),
      // Lead decision Q2: today's Actions-menu switch, a toolbar panel of its own (listed before Compact memory at, as today).
      panel(CONVERSATION_MODES_SLOT, { id: 'hypermedia', order: 25 }),
      // Whose turn it is (working, your turn, needs you), beside Ferrets' status mark (order 20, which has no turn to say).
      panel('ferret.toolbar', { id: 'turn', order: 21 }),
      // This device's conversation width (lead decision Q11).
      panel('device.settings', { id: 'chat-width', order: 20 }),
      // Settings › Appearance › Message marks: the key to the clock, ticks and ! under a message (S-0509). Last, after
      // the conversation width, as v4 draws it.
      panel('device.settings', { id: 'message-marks', order: 30 }),
      // Contributions to other plugins' slots (§5.2), each by the offerer's slot name: Ferrets' file browser gets the
      // current-ferret search, its Actions ▾ menu gets Interrupt and the stuck-message and Queue rows, and Agenda's ask page gets the ferret's conversation.
      panel(FILES_SEARCH_SLOT, { id: 'files-search', order: 10 }),
      panel(ACTIONS_ROW_SLOT, { id: 'interrupt-row', order: 10 }),
      // Clear stuck messages, Dismiss all cancelled and Queue… (`app/slots/stuck-messages-row-panel.tsx`).
      panel(ACTIONS_ROW_SLOT, { id: 'stuck-messages-row', order: 20 }),
      panel(AGENDA_CONVERSATION_SLOT, { id: 'agenda-conversation', order: 10 }),
    ],
    settings: [settingsTab('conversation', { icon: 'messages', group: 'behaviour', label: 'Conversation', order: 20 })],
    renderers: [renderer('ask', { source: 'question' })],
  },
});
