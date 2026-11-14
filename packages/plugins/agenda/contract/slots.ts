/**
 * THE SLOT AGENDA OFFERS (§5.2: plugin screens offer their own, named `<plugin>.<name>`; lead decision Q9).
 *
 * The ask page (and the Agenda page's open card) draws, under the ask, that ferret's conversation and composer, as
 * today's ask page did. Those are Conversation's, and Agenda must not know how they are drawn or read: the page OFFERS
 * this slot and mounts whatever panel an installed plugin contributes to it. Conversation contributes the panel;
 * neither half imports the other — the slot name and the props below are the whole agreement, so a daemon without
 * Conversation shows the ask with nothing under it.
 *
 * The props are plain data (no framework type: this is a contract). The page hands them to the slot with the shell's
 * `PanelSlot`, its `subject` being the ferret; a contributing panel reads them from its props.
 */

/** Under an open ask: its ferret's conversation and composer. */
export const AGENDA_CONVERSATION_SLOT = 'agenda.conversation' as const;

/** Every slot Agenda's pages offer, in one list a test can pair against the panels other plugins contribute. */
export const AGENDA_SLOTS = [AGENDA_CONVERSATION_SLOT] as const;
export type AgendaSlot = (typeof AGENDA_SLOTS)[number];

/** What the slot's page hands its panels, besides the shell's `subject` (the ferret). */
export interface AgendaConversationSlotProps {
  /** The ferret whose conversation it is. */
  readonly ferret: string;
  /** The ask open above it (`A3`): what a message typed there is about. */
  readonly ask: string;
  /**
   * Told when a message about the ask was accepted (what the owner wrote, the id it was queued under, what the
   * transport made of it): the page marks the Inbox item replied. Absent: nobody is told.
   */
  readonly onReplied?: (sent: {
    readonly words: string;
    readonly sendId?: string | undefined;
    readonly disposition?: string | undefined;
  }) => void;
  /** The words of a reply the owner took back (Undo): they go into the ask's box once, then `onRestored` fires. */
  readonly restore?: string;
  readonly onRestored?: () => void;
}

/** A narrowing for a contributing panel: the props are untyped at the shell, so the panel checks what it reads. */
export function isAgendaConversationSlotProps(props: unknown): props is AgendaConversationSlotProps {
  if (typeof props !== 'object' || props === null) return false;
  const candidate = props as Record<string, unknown>;
  return typeof candidate.ferret === 'string' && typeof candidate.ask === 'string';
}
