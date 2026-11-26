import type { Frame, Page } from 'playwright-core';
import { playwrightNodeOf } from '../target/lib/fields.ts';
import { carriesCredentialFragment, type NavigationLedger } from '../target/lib/navigation-evidence.ts';

/**
 * Playwright reports same-document and new-document commits through one event, including OOPIFs that the main CDP
 * session cannot see. Describe the actual Document by its DevTools target and backend node: replaceState keeps it,
 * a real navigation replaces it. Until that comparison answers, retain the linked bit. A link observed while sampling is charged
 * to the sampled document conservatively, so a rapid navigation can only cause an extra refusal.
 */
export function watchNavigationDocuments(page: Page, ledger: NavigationLedger): void {
  let serial = 0;
  const frames = new Map<
    Frame,
    { id: string; document?: { target: string; node: number }; revision: number; linked: boolean }
  >();
  const stateOf = (frame: Frame) => {
    let state = frames.get(frame);
    if (state === undefined) {
      state = { id: `pw:${++serial}`, revision: 0, linked: false };
      frames.set(frame, state);
    }
    return state;
  };
  const navigated = (frame: Frame): void => {
    const state = stateOf(frame);
    const revision = ++state.revision;
    const address = frame.url();
    const hash = address.indexOf('#');
    state.linked ||= hash >= 0 && carriesCredentialFragment(address.slice(hash));
    ledger.commit(state.id, address, frame === page.mainFrame(), true);
    void (async () => {
      try {
        const handle = await frame.evaluateHandle(() => document);
        const described = await playwrightNodeOf(handle).finally(
          async () => await handle.dispose().catch(() => undefined),
        );
        const facts =
          described.node !== null && typeof described.node === 'object'
            ? (described.node as Record<string, unknown>)
            : {};
        const node = facts.backendNodeId;
        const target = described.targetId;
        if (
          facts.nodeType !== 9 ||
          typeof node !== 'number' ||
          !Number.isSafeInteger(node) ||
          node <= 0 ||
          typeof target !== 'string' ||
          target === ''
        )
          throw new Error('the browser could not identify the document');
        const current = { target, node };
        const previous = state.document;
        const same = previous === undefined || (previous.target === current.target && previous.node === current.node);
        if (frames.get(frame) !== state || revision !== state.revision) return;
        ledger.commit(state.id, frame.url(), frame === page.mainFrame(), same || state.linked);
        state.linked = false;
        state.document = current;
      } catch {
        // An unreadable document is never evidence that the document carrying a link has gone.
        if (frames.get(frame) === state && revision === state.revision) ledger.lose();
      }
    })();
  };
  page.on('framenavigated', navigated);
  page.on('frameattached', frame => ledger.attached(stateOf(frame).id));
  page.on('framedetached', frame => {
    const state = frames.get(frame);
    if (state === undefined) return;
    frames.delete(frame);
    ledger.detached(state.id);
  });
  page.on('close', () => {
    frames.clear();
  });
}
