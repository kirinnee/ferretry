/**
 * The ferret's header menu: what a person can do to or learn about THIS ferret (the Actions rows and Info). The header's
 * main line is the name and the status; everything else is one click behind its single menu button, which Conversation's
 * chat draws and which mounts every panel contributed here (Ferrets contributes `actions` and `info`), with the ferret
 * as the panel's `subject`, ahead of the modes (`conversation.modes`). Ferrets owns the name so the menu's host imports
 * nothing of a contributor and Ferrets nothing of the host.
 */
export const FERRET_MENU_SLOT = 'ferrets.menu' as const;

export default { slot: FERRET_MENU_SLOT } as const;
