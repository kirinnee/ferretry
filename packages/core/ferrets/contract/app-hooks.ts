/**
 * THE APP HOOKS FERRETS OFFERS (§5.2; `@ferretry/app`'s `useAppHook`, a provider's `shell.hooks`).
 *
 * Which ferrets have something waiting on the owner is the Agenda's fact (its open items), and the list that gathers
 * them into "Needs you" at the top is Ferrets'. Neither half imports the other: Ferrets OFFERS the hook below and the
 * plugin that holds the items PROVIDES it, over its own client on one daemon. The name and the shape are the whole
 * agreement; Ferrets narrows what it is given before it reads it.
 *
 * FAIL CLOSED. With no provider (Agenda not installed, not allowed on that daemon, or two plugins providing the name),
 * the list draws as it does without one: every ferret in its folder, nothing gathered.
 *
 * The value is plain data and functions (no framework type: this is a contract).
 */
// One file per hook in `app-hooks/`; this re-exports the generated barrel (and the two records) of them.
export * from './generated/app-hooks.ts';
