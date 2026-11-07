import type { SessionView } from '@ferretry/protocol';

/**
 * Keeps the view a derived mark made from one input view, so the same input answers with the same output.
 *
 * WHY IDENTITY MATTERS. The session reader hands out the same view object while a session's documents have
 * not moved, and the list route recognises an unchanged fleet by that identity. A layer that maps every view
 * to a fresh `{ ...view, mark }` on every call would turn each unchanged session into a new object and defeat
 * both. So each layer remembers, per input view, what it last made and the facts the mark depended on (the
 * pin, the window, the outdated sections); the same input with the same facts is the same output, and a
 * changed fact makes a new one.
 *
 * Held weakly by the input view, so a session that moves on takes its remembered output with it.
 */
export function createViewMemo<Fact>(same: (left: Fact, right: Fact) => boolean = Object.is) {
  const made = new WeakMap<SessionView, { readonly fact: Fact; readonly view: SessionView }>();
  return (input: SessionView, fact: Fact, make: () => SessionView): SessionView => {
    const known = made.get(input);
    if (known !== undefined && same(known.fact, fact)) return known.view;
    const view = make();
    made.set(input, { fact, view });
    return view;
  };
}
