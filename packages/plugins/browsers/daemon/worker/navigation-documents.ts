import type { Frame, Page } from 'playwright-core';
import type { NavigationLedger } from '../target/lib/navigation-evidence.ts';

/**
 * Browser-owned committed loader identity, never the page's `document` variable or URL. This uses the same pinned
 * Playwright in-process connection as fields.playwrightNodeOf (PLAYWRIGHT_REACHED_VERSION and its bump tests).
 * Chromium's frame commit sets _currentDocument before Playwright publishes framenavigated; a same-document move
 * leaves it alone. An absent identity cannot prove that the linked document has gone.
 */
function committedDocumentOf(frame: unknown): string | undefined {
  const client = frame as { readonly _connection?: { toImpl?: (object: unknown) => unknown } } | null;
  const server = client?._connection?.toImpl?.(frame) as
    | { readonly _currentDocument?: { readonly documentId?: unknown } }
    | undefined;
  const id = server?._currentDocument?.documentId;
  return typeof id === 'string' && id !== '' ? id : undefined;
}

/** Playwright is the feed for OOPIFs too; distinguish its same-document events by the browser's real loader identity. */
export function watchNavigationDocuments(page: Page, ledger: NavigationLedger): void {
  let serial = 0;
  const frames = new Map<Frame, { id: string; document?: string }>();
  const stateOf = (frame: Frame) => {
    let state = frames.get(frame);
    if (state === undefined) {
      state = { id: `pw:${++serial}` };
      frames.set(frame, state);
    }
    return state;
  };
  page.on('framenavigated', frame => {
    const state = stateOf(frame);
    const document = committedDocumentOf(frame);
    const same = document === undefined || state.document === undefined || document === state.document;
    ledger.commit(state.id, frame.url(), frame === page.mainFrame(), same);
    // An unreadable loader invalidates the baseline: it may precede a link observed during the gap.
    state.document = document;
  });
  page.on('frameattached', frame => ledger.attached(stateOf(frame).id));
  page.on('framedetached', frame => {
    const state = frames.get(frame);
    if (state === undefined) return;
    frames.delete(frame);
    ledger.detached(state.id);
  });
  page.on('close', () => frames.clear());
}
