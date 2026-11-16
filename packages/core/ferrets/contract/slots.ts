/**
 * THE SLOTS FERRETS OFFERS (§5.2: plugin screens offer their own, named `<plugin>.<name>`).
 *
 * Two places in Ferrets' own pages need to ask "which runtime?" and Ferrets must not know how that is drawn or read:
 * the page that starts a new ferret, and the page that moves a ferret to another runtime. Each page OFFERS a slot and
 * mounts whatever panels any installed plugin contributes to it; Runtimes contributes the runtime picker (with its
 * health and quota). Neither half imports the other — the slot name and the props below are the whole agreement, so a
 * daemon without Runtimes shows the page without a picker and a Runtimes without these pages shows nothing extra.
 *
 * The props are plain data and callbacks (no framework type: this is a contract). A page hands them to the slot with
 * the shell's `PanelSlot`; a contributing panel reads them from its props and answers only through the callbacks.
 */
// One file per slot in `slots/`; this re-exports the generated barrel, so a new slot edits no list here.
export * from './generated/slots.ts';
