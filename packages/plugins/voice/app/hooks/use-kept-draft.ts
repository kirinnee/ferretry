/**
 * A FIELD THAT KEEPS WHAT THE PERSON TYPED.
 *
 * A settings field shows a value the machine holds, and that value can move while somebody is typing:
 * the person's own save landing, another device changing it, a background re-read. A field bound
 * straight to the machine's value — or re-mounted with a `key` of it — threw the typing away each time,
 * which is what "it keeps refreshing, esp after I typed" was.
 *
 * The rule here is the one every settings field follows:
 *
 * - **Untouched**, the field follows the machine's value.
 * - **Edited** (`dirty`), it keeps the person's text, whatever the machine's value does meanwhile.
 * - When the machine's value moved **away from the one the edit began on**, `changedElsewhere` says so,
 *   and the field offers to `reload` instead of silently picking one.
 * - The person's own save landing — the machine now holds exactly what was typed — ends the edit.
 */

import { useState } from 'react';

export interface KeptDraft<T> {
  /** What the field shows: the person's text while they edit, the machine's value otherwise. */
  readonly value: T;
  /** The person changed it and has not saved, or saved something else. */
  readonly dirty: boolean;
  /** The machine's value moved during the edit. The field should offer {@link reload}. */
  readonly changedElsewhere: boolean;
  /** The person typed. Typing the machine's value back ends the edit. */
  readonly set: (next: T) => void;
  /** Throw the edit away and show the machine's value. */
  readonly reload: () => void;
}

interface Edit<T> {
  readonly value: T;
  /** The machine's value when the edit began, so a later move can be noticed. */
  readonly from: T;
}

export function useKeptDraft<T>(saved: T, equal: (a: T, b: T) => boolean = Object.is): KeptDraft<T> {
  const [edit, setEdit] = useState<Edit<T> | null>(null);
  // The machine now holds what was typed — the person's own save landed, or the same value arrived from
  // elsewhere. Settled during render, so no frame ever shows the edit as still open.
  if (edit !== null && equal(edit.value, saved)) setEdit(null);
  const open = edit !== null && !equal(edit.value, saved) ? edit : null;
  return {
    value: open === null ? saved : open.value,
    dirty: open !== null,
    changedElsewhere: open !== null && !equal(open.from, saved),
    set: next => setEdit(current => (equal(next, saved) ? null : { value: next, from: current?.from ?? saved })),
    reload: () => setEdit(null),
  };
}
