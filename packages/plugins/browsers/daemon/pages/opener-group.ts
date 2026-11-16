/**
 * THE PAGES THAT CAN REACH EACH OTHER'S DOCUMENTS: a page, the page that opened it, the pages it opened, and so on
 * (`window.opener`, a `window.open` handle). A script run in one of them can read the DOM of a same-origin member, so
 * a protection that holds for the named page alone leaves the others as a way round it.
 *
 * Followed through `openerId` both ways to the end, bounded by the number of pages there are; always contains `pageId`.
 */
export function openerGroup(
  pages: readonly { readonly id: string; readonly openerId?: string }[],
  pageId: string,
): readonly string[] {
  const group = new Set<string>([pageId]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const page of pages) {
      if (page.openerId === undefined || !(group.has(page.openerId) || group.has(page.id))) continue;
      for (const id of [page.id, page.openerId]) {
        if (id !== undefined && !group.has(id)) {
          group.add(id);
          grew = true;
        }
      }
    }
  }
  return [...group];
}

/**
 * Whether a page at `address` can script documents of the page at `named`: it is on the same origin, or on one nobody can
 * read (either address unparsable). An opaque origin (`about:blank`, `data:`) is taken for the same as any other opaque
 * one, because it may have inherited its creator's. Fails closed: it errs toward "yes".
 */
export function sameOriginOrUnplaced(address: string, named: string | undefined): boolean {
  if (named === undefined) return true;
  try {
    return new URL(address).origin === new URL(named).origin;
  } catch {
    return true;
  }
}
