/**
 * A composer standing where Conversation's does: registered with the APP's composer quote targets (`@ferretry/app`),
 * under `(daemonId, ferretId[, item])`, exactly as Conversation's composer registers itself. Agenda's views must reach
 * it from their own `sessionId` scopes; a test that registered anywhere else would pass while the product quotes into
 * nothing.
 */

import { daemonFerretScope, registerComposerQuoteTarget } from '@ferretry/app';

export interface FakeComposer {
  readonly daemonId: string;
  /** The ferret the composer belongs to (Agenda's `sessionId`). */
  readonly sessionId: string;
  /** The Inbox card's draft slot; absent is the ferret's chat. */
  readonly item?: string;
  readonly draft: () => string;
  readonly replaceDraft: (next: string) => void;
}

/** Registers the composer as the app's quote target for its scope; the disposer removes only this registration. */
export const registerComposerFor = (composer: FakeComposer): (() => void) =>
  registerComposerQuoteTarget({
    ...daemonFerretScope(composer, composer.sessionId, composer.item),
    draft: composer.draft,
    replaceDraft: composer.replaceDraft,
  });
