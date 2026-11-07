/**
 * Opening an open item's folded parts in a unit test. Kept apart from `agenda-inbox.tsx` on purpose: that module is
 * also bundled into the browser scenes of the integration tier, and `dom.ts` (happy-dom) must never reach a browser
 * build.
 */
import { interact } from './dom.ts';

/** Opens the open item's folded Conversation inside `root`, where it has one. */
export const openConversation = async (root: ParentNode): Promise<void> => {
  const toggle = root.querySelector<HTMLButtonElement>('[data-agenda-fold="conversation"]');
  if (toggle === null || toggle.getAttribute('aria-expanded') === 'true') return;
  await interact(() => toggle.click());
};
