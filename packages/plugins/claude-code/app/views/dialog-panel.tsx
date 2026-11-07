/**
 * The harness-dialog card's panel above the composer. GAP, said out loud: the ferret is the panel's `subject`, but the
 * Ferrets contract gives the app no read of "what the ferret is stopped on", so there is nothing to draw the card
 * from yet; the panel stays empty until that read exists. The card itself (`./prompt-cards.tsx`) is complete.
 */

import type { AppComponent, PanelProps } from '@ferretry/kernel/manifest';

export const createPanel = (_client: unknown): AppComponent<PanelProps> =>
  function DialogPanel() {
    return null;
  };
